import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { grantWorkspace } from './workspace.mjs';
import { start, tools } from './worker.mjs';
import { request, collectTask } from './client.mjs';

const MiB = 1024 * 1024;
async function fixture(run) {
  const base = mkdtempSync(join(tmpdir(), 'webgpt-boundary-'));
  const dir = join(base, 'runtime'), root = join(base, 'project'); mkdirSync(root);
  let service;
  const config = { dataDir: dir };
  const boot = async () => {
    service = await start({ dir, port: 0, controlPort: 0, waitMs: 20 });
    config.mcpPort = service.mcpPort; config.controlPort = service.controlPort;
  };
  const post = async (message, headers = {}, raw = false) => {
    const response = await fetch(`http://127.0.0.1:${config.mcpPort}/mcp`, {
      method: 'POST', headers, body: raw ? message : JSON.stringify(message),
    });
    const text = await response.text();
    return { status: response.status, text, message: text ? JSON.parse(text) : null };
  };
  const rpc = async (method, params) => (await post({ jsonrpc: '2.0', id: 1, method, params })).message;
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  const admin = (action, payload) => request(action, payload, config);
  const register = (id = 'editor') => admin('register', {
    id, instructions: 'Fixture-only verification.', inputs: {}, workspace: { root, mode: 'edit' },
  });
  const restart = async () => { await service.close(); service = null; await boot(); };
  try { await boot(); await run({ base, dir, root, config, post, rpc, call, admin, register, restart }); }
  finally { if (service) await service.close(); rmSync(base, { recursive: true, force: true }); }
}

function mutation(token, path = 'forbidden.txt') {
  return { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'write_file', arguments: { token, path, text: 'must not be written', expectedSha256: null },
  } };
}

test('a tool invocation without a request ID cannot mutate files or produce receipts', () => fixture(async f => {
  const { token } = await f.register();
  const msg = mutation(token); delete msg.id;
  assert.equal((await f.post(msg)).status, 400);
  assert.equal(existsSync(join(f.root, 'forbidden.txt')), false);
  assert.deepEqual((await f.call('get_task', { token })).structuredContent.changes, []);
}));

test('malformed JSON-RPC envelopes and invalid IDs fail before side effects', () => fixture(async f => {
  const { token } = await f.register();
  for (const extra of [{ jsonrpc: '1.0' }, { jsonrpc: null }, { id: null }, { id: true }, { id: [] }, { id: {} }, { id: 1.5 }]) {
    assert.equal((await f.post({ ...mutation(token), ...extra })).status, 400);
  }
  const missingVersion = mutation(token); delete missingVersion.jsonrpc;
  assert.equal((await f.post(missingVersion)).status, 400);
  assert.equal(existsSync(join(f.root, 'forbidden.txt')), false);
}));

test('valid numeric and string IDs are preserved and ping does not touch task state', () => fixture(async f => {
  const { token } = await f.register();
  const state = readFileSync(join(f.dir, 'state.json'), 'utf8');
  for (const id of [0, 23, 'check-1']) {
    const response = await f.post({ jsonrpc: '2.0', id, method: 'ping' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.message, { jsonrpc: '2.0', id, result: {} });
  }
  assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8'), state);
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
}));

test('notifications have empty 202 replies and do not cancel logical tasks', () => fixture(async f => {
  const { token } = await f.register();
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/unknown']) {
    const response = await f.post({ jsonrpc: '2.0', method, params: { requestId: 1 } });
    assert.equal(response.status, 202); assert.equal(response.text, '');
  }
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
}));

test('protocol negotiation reports a supported version rather than echoing arbitrary input', () => fixture(async f => {
  for (const protocolVersion of ['2025-03-26', '2025-06-18']) {
    const result = await f.rpc('initialize', { protocolVersion });
    assert.equal(result.result.protocolVersion, protocolVersion);
  }
  const fallback = await f.rpc('initialize', { protocolVersion: 'not-a-protocol' });
  assert.equal(fallback.result.protocolVersion, '2025-06-18');
  assert.equal((await f.rpc('initialize', { protocolVersion: {} })).error.code, -32602);
  assert.equal((await f.rpc('initialize')).result.protocolVersion, '2025-03-26');
}));

test('an unsupported protocol header cannot dispatch a valid mutation', () => fixture(async f => {
  const { token } = await f.register();
  const response = await f.post(mutation(token), { 'MCP-Protocol-Version': 'unsupported' });
  assert.equal(response.status, 400);
  assert.equal(existsSync(join(f.root, 'forbidden.txt')), false);
  assert.equal((await f.post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2025-06-18' })).status, 200);
}));

test('non-object params and argument containers never reach a tool operation', () => fixture(async f => {
  const { token } = await f.register();
  for (const params of [null, [], 'text', 123]) {
    const response = await f.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    assert.equal(response.status, 400);
  }
  for (const args of [null, [], 'text', 123]) {
    const result = await f.call('write_file', args);
    assert.equal(result.isError, true);
  }
  assert.deepEqual((await f.call('get_task', { token })).structuredContent.changes, []);
}));

test('unexpected tool arguments are rejected in accordance with the advertised schemas', () => fixture(async f => {
  const { token } = await f.register();
  const args = mutation(token).params.arguments;
  const result = await f.call('write_file', { ...args, overwrite: true });
  assert.equal(result.isError, true);
  assert.equal(existsSync(join(f.root, 'forbidden.txt')), false);
  assert.deepEqual((await f.call('get_task', { token })).structuredContent.changes, []);
  assert.equal(tools.length, 7);
}));

test('invalid wire UTF-8 is rejected rather than silently replacing bytes in a file', () => fixture(async f => {
  const { token } = await f.register();
  const prefix = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'write_file', arguments: { token, path: 'broken.txt', expectedSha256: null, text: 'MARKER' },
  } });
  const [before, after] = prefix.split('MARKER');
  const response = await f.post(Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)]), {}, true);
  assert.equal(response.status, 400);
  assert.equal(existsSync(join(f.root, 'broken.txt')), false);
}));

test('a fully escaped 1 MiB text file fits the transport and round trips with its SHA', () => fixture(async f => {
  const { token } = await f.register();
  const text = '\u0001'.repeat(MiB);
  const response = await f.post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'write_file', arguments: { token, path: 'escaped.txt', text, expectedSha256: null },
  } });
  assert.equal(response.status, 200);
  assert.equal(response.message.result.isError, false);
  assert.equal(readFileSync(join(f.root, 'escaped.txt'), 'utf8'), text);
  assert.equal(response.message.result.structuredContent.afterSha256, createHash('sha256').update(text).digest('hex'));
}));

test('escaped 1 MiB results can be submitted and collected without loosening decoded limits', () => fixture(async f => {
  const { token } = await f.register();
  const text = '\u0001'.repeat(MiB);
  const out = await f.call('submit_result', { token, status: 'completed', summary: 'escaped result', result: text });
  assert.equal(out.isError, false);
  const collected = await collectTask('editor', f.config);
  assert.equal(readFileSync(collected.artifact, 'utf8'), text);
}));

test('decoded file/result limits still reject payloads above 1 MiB', () => fixture(async f => {
  const { token } = await f.register();
  const text = '\u0001'.repeat(MiB + 1);
  assert.equal((await f.call('write_file', { token, path: 'too-big.txt', text, expectedSha256: null })).isError, true);
  assert.equal((await f.call('submit_result', { token, status: 'completed', summary: '', result: text })).isError, true);
  assert.equal(existsSync(join(f.root, 'too-big.txt')), false);
  assert.equal((await f.call('get_task', { token })).structuredContent.status, 'running');
}));

test('lone UTF-16 surrogates are rejected without breaking normal Unicode', () => fixture(async f => {
  const { token } = await f.register();
  for (const text of ['\ud800', '\udc00']) {
    assert.equal((await f.call('write_file', { token, path: 'surrogate.txt', text, expectedSha256: null })).isError, true);
  }
  assert.equal(existsSync(join(f.root, 'surrogate.txt')), false);
  const text = '한국어 🎾';
  assert.equal((await f.call('write_file', { token, path: 'unicode.txt', text, expectedSha256: null })).isError, false);
  assert.equal(readFileSync(join(f.root, 'unicode.txt'), 'utf8'), text);
}));

async function recoveryFixture(run) {
  return fixture(async f => {
    writeFileSync(join(f.root, 'source.txt'), 'before');
    const { token } = await f.register('damaged');
    const before = (await f.call('read_file', { token, path: 'source.txt' })).structuredContent;
    const receipt = (await f.call('write_file', { token, path: 'source.txt', text: 'after', expectedSha256: before.sha256 })).structuredContent;
    const other = await f.register('independent');
    const journal = join(f.dir, 'recovery', 'damaged', receipt.operation + '.json');
    const original = JSON.parse(readFileSync(journal, 'utf8'));
    const assertBlocked = async () => {
      assert.deepEqual((await f.admin('status')).recoveryRequired?.map(t => t.id), ['damaged']);
      const task = (await f.call('get_task', { token })).structuredContent;
      assert.equal(task.recoveryRequired.length > 0, true);
      assert.equal((await f.call('write_file', { token, path: 'new.txt', text: 'no', expectedSha256: null })).isError, true);
      assert.equal((await f.call('submit_result', { token, status: 'completed', summary: '', result: 'no' })).isError, true);
      assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'after');
      assert.equal(readFileSync(receipt.backup, 'utf8'), 'before');
      assert.equal((await f.call('get_task', { token: other.token })).structuredContent.status, 'running');
    };
    await run({ ...f, token, other, receipt, journal, original, assertBlocked });
  });
}

test('a null recovery journal isolates the task instead of preventing shared-worker startup', () => recoveryFixture(async f => {
  writeFileSync(f.journal, 'null');
  await f.restart(); await f.assertBlocked();
  assert.equal(readFileSync(f.journal, 'utf8'), 'null');
  assert.equal((await f.call('submit_result', { token: f.other.token, status: 'completed', summary: '', result: 'independent done' })).isError, false);
  await collectTask('independent', f.config);
}));

test('syntactically valid but incomplete applied journals are not treated as successful receipts', () => recoveryFixture(async f => {
  writeFileSync(f.journal, JSON.stringify({ state: 'applied' }));
  await f.restart(); await f.assertBlocked();
  const task = (await f.call('get_task', { token: f.token })).structuredContent;
  assert.equal(task.changes.length, 1);
  assert.ok(task.changes.every(c => typeof c.operation === 'string'));
}));

test('recovery validates filename, action, path, hashes and backup location before trusting a receipt', () => recoveryFixture(async f => {
  for (const change of [
    { operation: 'wrong-operation' }, { action: 'execute' }, { path: '../outside' }, { path: '.GIT/config' },
    { beforeSha256: null }, { afterSha256: null }, { backup: join(f.base, 'not-the-backup.txt') },
  ]) {
    writeFileSync(f.journal, JSON.stringify({ ...f.original, ...change }));
    await f.restart(); await f.assertBlocked();
  }
}));

test('a non-directory recovery path blocks only its task and preserves the damaged record', () => recoveryFixture(async f => {
  const recovery = join(f.dir, 'recovery', 'damaged');
  rmSync(recovery, { recursive: true }); writeFileSync(recovery, 'damaged directory fixture');
  await f.restart();
  const task = (await f.call('get_task', { token: f.token })).structuredContent;
  assert.deepEqual(task.recoveryRequired, [recovery]);
  assert.equal(readFileSync(recovery, 'utf8'), 'damaged directory fixture');
  assert.equal((await f.call('get_task', { token: f.other.token })).structuredContent.status, 'running');
}));

test('valid applied journals restore missing receipts without replaying file edits', () => recoveryFixture(async f => {
  const statePath = join(f.dir, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.find(t => t.id === 'damaged').changes = [];
  writeFileSync(statePath, JSON.stringify(state));
  await f.restart();
  const task = (await f.call('get_task', { token: f.token })).structuredContent;
  assert.deepEqual(task.changes, [f.receipt]); assert.deepEqual(task.recoveryRequired, []);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'after');
}));

test('oversized wire bodies are rejected and do not disable the worker', () => fixture(async f => {
  const response = await f.post(' '.repeat(8 * MiB + 1), {}, true);
  assert.equal(response.status, 413);
  assert.equal((await f.rpc('ping')).result !== undefined, true);
  await f.register('large-control');
  await assert.rejects(f.admin('register', {
    id: 'too-large', instructions: 'x'.repeat(2 * MiB), inputs: {},
  }), /request too large/);
  assert.equal((await f.admin('tasks')).running, 1);
}));

test('conflicting journal and saved-state receipts are not silently reconciled', () => recoveryFixture(async f => {
  writeFileSync(f.journal, JSON.stringify({ ...f.original, afterSha256: '0'.repeat(64) }));
  await f.restart(); await f.assertBlocked();
}));

test('a linked shared recovery directory cannot import receipts from another location', () => recoveryFixture(async f => {
  const recovery = join(f.dir, 'recovery'), detached = join(f.base, 'detached-recovery');
  renameSync(recovery, detached);
  symlinkSync(detached, recovery, process.platform === 'win32' ? 'junction' : 'dir');
  const statePath = join(f.dir, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.find(t => t.id === 'damaged').changes = [];
  writeFileSync(statePath, JSON.stringify(state));
  await f.restart();
  const task = (await f.call('get_task', { token: f.token })).structuredContent;
  assert.deepEqual(task.changes, [], 'do not import a receipt through the shared directory link');
  assert.ok(task.recoveryRequired.length);
  assert.equal((await f.call('submit_result', { token: f.token, status: 'completed', summary: '', result: 'no' })).isError, true);
  assert.equal(readFileSync(join(f.root, 'source.txt'), 'utf8'), 'after');
  assert.deepEqual(JSON.parse(readFileSync(join(detached, 'damaged', f.receipt.operation + '.json'), 'utf8')), f.original);
  assert.equal((await f.call('get_task', { token: f.other.token })).isError, false);
}));

test('multiply linked journals are preserved but never accepted for recovery', () => recoveryFixture(async f => {
  linkSync(f.journal, join(f.base, 'journal-alias.json'));
  await f.restart(); await f.assertBlocked();
  assert.deepEqual(JSON.parse(readFileSync(f.journal, 'utf8')), f.original);
}));

test('live error recovery isolates malformed journals without waiting for a worker restart', () => recoveryFixture(async f => {
  writeFileSync(f.journal, 'null');
  const result = await f.call('write_file', { token: f.token, path: 'source.txt', text: 'stale', expectedSha256: null });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /supervisor recovery required/);
  await f.assertBlocked();
  assert.equal((await f.call('submit_result', { token: f.other.token, status: 'completed', summary: '', result: 'independent done' })).isError, false);
}));


// Valid UTF-8 JSON may still decode escaped unpaired UTF-16 surrogates. Test
// admission separately from wire decoding and the existing tool-argument guard.
for (const field of ['instructions', 'name', 'value']) test(`registration rejects ill-formed ${field} before persisting a task`, () => fixture(async f => {
  for (const bad of ['\ud800', '\udfff', 'left\ud800right', '\udfff\ud800']) {
    const payload = { id: 'rejected', instructions: 'unchanged', inputs: { doc: 'text' } };
    if (field === 'instructions') payload.instructions = bad;
    if (field === 'name') payload.inputs = { [bad]: 'text' };
    if (field === 'value') payload.inputs.doc = bad;
    // JSON.stringify escapes these code units, so the transport bytes are valid UTF-8.
    const wire = Buffer.from(JSON.stringify(payload));
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(wire), wire.toString());
    await assert.rejects(f.admin('register', payload), error => {
      assert.equal(error.statusCode, 400); assert.match(error.message, /well-formed Unicode/); return true;
    });
    assert.equal(existsSync(join(f.dir, 'state.json')), false);
    assert.equal(existsSync(join(f.dir, 'state.initialized')), false);
    assert.equal(existsSync(join(f.dir, 'state.json.tmp')), false);
    assert.equal(existsSync(join(f.dir, 'recovery')), false);
  }
  const valid = { id: 'rejected', instructions: 'unchanged', inputs: { doc: 'text' } };
  const accepted = await f.admin('register', valid), before = readFileSync(join(f.dir, 'state.json'));
  const retry = await f.admin('register', valid);
  assert.equal(retry.duplicate, true); assert.equal(retry.token, accepted.token);
  await assert.rejects(f.admin('register', { ...valid, instructions: '\ud800' }), /well-formed Unicode/);
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
}));

test('workspace roots reject lossy Unicode before resolving a replacement-character directory', () => fixture(async f => {
  const root = join(f.base, 'project-\ufffd'); mkdirSync(root); writeFileSync(join(root, 'original.txt'), 'preserve');
  for (const bad of ['\ud800', '\udfff']) {
    const workspace = { root: join(f.base, 'project-' + bad), mode: 'edit' };
    assert.throws(() => grantWorkspace(workspace), /workspace/);
    await assert.rejects(f.admin('register', { id: 'bad-root', instructions: '', inputs: {}, workspace }), error => {
      assert.equal(error.statusCode, 400); return true;
    });
    assert.equal(existsSync(join(f.dir, 'state.json')), false);
    assert.equal(readFileSync(join(root, 'original.txt'), 'utf8'), 'preserve');
  }
  // An intentionally supplied U+FFFD is valid and must not be banned or normalized.
  const workspace = { root, mode: 'read' }, { token } = await f.admin('register', { id: 'valid-root', instructions: '', inputs: {}, workspace });
  assert.deepEqual((await f.call('get_task', { token })).structuredContent.workspace, grantWorkspace(workspace));
  assert.equal((await f.call('read_file', { token, path: 'original.txt' })).structuredContent.text, 'preserve');
}));

test('registration preserves valid Unicode, literal escapes and exact full/window input digests across restart', () => fixture(async f => {
  const instructions = '\ufeff한글 🎾 e\u0301 \ufffd\r\nzero\0end';
  const inputs = Object.fromEntries([['자료 🧪', instructions], ['literal', '\\ud800'], ['__proto__', 'own'], ['empty', ''],
    ['composed', '\u00e9'], ['decomposed', 'e\u0301']]);
  const { token } = await f.admin('register', { id: 'valid-unicode', instructions, inputs });
  for (const reboot of [false, true]) {
    if (reboot) await f.restart();
    const before = readFileSync(join(f.dir, 'state.json'));
    const task = (await f.call('get_task', { token })).structuredContent;
    assert.equal(task.instructions, instructions); assert.deepEqual(task.inputs, Object.keys(inputs));
    for (const [name, text] of Object.entries(inputs)) {
      const full = await f.call('read_input', { token, name }), page = await f.call('read_input', { token, name, limit: 10 });
      assert.equal(full.isError, false); assert.equal(page.isError, false);
      assert.deepEqual(full.structuredContent, { name, text }); assert.equal(page.structuredContent.text, text);
      assert.equal(page.structuredContent.sha256, createHash('sha256').update(Buffer.from(text)).digest('hex'));
      assert.equal(page.structuredContent.partial, false);
    }
    assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  }
}));

test('legacy malformed text is preserved and isolated without a startup-wide rejection or lossy reads', () => fixture(async f => {
  const { token } = await f.admin('register', { id: 'legacy', instructions: 'review', inputs: { doc: 'valid', safe: 'readable' } });
  const other = await f.admin('register', { id: 'healthy', instructions: 'independent', inputs: {} });
  const path = join(f.dir, 'state.json');
  for (const field of ['instructions', 'name', 'value']) {
    const saved = JSON.parse(readFileSync(path)), legacy = saved.find(t => t.id === 'legacy');
    legacy.instructions = field === 'instructions' ? 'PRIVATE_BAD\ud800' : 'review';
    legacy.inputs = field === 'name' ? { ['PRIVATE_BAD\udfff']: 'kept', safe: 'readable' }
      : { doc: field === 'value' ? 'PRIVATE_BAD\ud800' : 'valid', safe: 'readable' };
    // Model a retained older state, not concurrent edits that bypass verifyState.
    writeFileSync(path, JSON.stringify(saved)); await f.restart();
    const before = readFileSync(path), overview = await f.call('get_task', { token });
    assert.equal(overview.isError, field !== 'value');
    if (overview.isError) assert.equal(JSON.stringify(overview).includes('PRIVATE_BAD'), false);
    if (field === 'value') for (const options of [{}, { limit: 1 }]) {
      const out = await f.call('read_input', { token, name: 'doc', ...options });
      assert.equal(out.isError, true); assert.equal(out.structuredContent, undefined);
      assert.equal(JSON.stringify(out).includes('PRIVATE_BAD'), false);
    }
    assert.equal((await f.call('read_input', { token, name: 'safe' })).structuredContent.text, 'readable');
    assert.equal((await f.call('get_task', { token: other.token })).structuredContent.status, 'running');
    assert.deepEqual(readFileSync(path), before, 'no normalization, repair, cancellation or evidence rewrite on read');
  }
  await f.admin('cancel', { id: 'legacy' });
  assert.equal((await f.call('get_task', { token })).isError, true);
  assert.equal((await f.call('get_task', { token: other.token })).isError, false);
}));

test('CLI registration rejects JSON-escaped surrogate input without modifying or echoing the private source', () => fixture(async f => {
  const file = join(f.base, 'request.json'), config = join(f.base, 'config.json');
  const payload = { id: 'cli-invalid', instructions: 'PRIVATE_REQUEST', inputs: { doc: 'PRIVATE_INPUT\ud800' } };
  writeFileSync(file, JSON.stringify(payload)); writeFileSync(config, JSON.stringify(f.config));
  const before = readFileSync(file);
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'register', file], {
    env: { ...process.env, WEBGPT_CONFIG: config, WEBGPT_DATA_DIR: f.dir }, timeout: 10000, windowsHide: true,
  }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, ''); assert.match(error.stderr, /well-formed Unicode/);
    for (const secret of ['PRIVATE_REQUEST', 'PRIVATE_INPUT', file]) assert.ok(!error.stderr.includes(secret));
    return true;
  });
  assert.deepEqual(readFileSync(file), before); assert.equal(existsSync(join(f.dir, 'state.json')), false);
}));
