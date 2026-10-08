// Same values, fewer wire copies only when explicitly requested. No browser claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as protocol from './protocol.mjs';
import { observeFileRead } from './test-fixtures/file-read.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const text = '\ufeff한국어 🧪\r\n"quotes" \\ literal\rthird\n';
for (const value of [{ path: 'absent', exists: false, text: null, sha256: null },
  { name: 'empty', text: '' }, { name: 'owned', text: text + '\0' },
  { path: 'owned', exists: true, text, sha256: digest(text), mode: 0o644,
    partial: false, startLine: 1, endLine: 3, totalLines: 3, nextOffset: null }]) {
  test(`text result preserves exact JSON for ${value.name ?? value.path}`, () => {
    const expected = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
    assert.deepEqual(protocol.toolSuccess(value), expected);
    assert.deepEqual(protocol.toolSuccess(value, 'dual'), expected);
    const single = protocol.toolSuccess(value, 'text');
    assert.deepEqual(single, { content: expected.content, isError: false });
    assert.deepEqual(JSON.parse(single.content[0].text), value);
    for (const invalid of [null, true, 'structured', 'TEXT', ''])
      assert.throws(() => protocol.toolSuccess(value, invalid), /invalid response format/);
  });
}

test('text-only envelope removes a duplicate body rather than shortening its contents', t => {
  const value = { name: 'large', text: text.repeat(10000) };
  const serialize = result => JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  const dual = serialize(protocol.toolSuccess(value)), single = serialize(protocol.toolSuccess(value, 'text'));
  assert.deepEqual(JSON.parse(JSON.parse(single).result.content[0].text), value);
  assert.ok(Buffer.byteLength(single) < Buffer.byteLength(dual) * 0.65);
  t.diagnostic(JSON.stringify({ sourceBytes: Buffer.byteLength(value.text), dualBytes: Buffer.byteLength(dual),
    textBytes: Buffer.byteLength(single) }));
});

async function fixture(t, mode = 'edit') {
  const { start } = await import('./worker.mjs');
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-read-response-')));
  const dir = join(base, 'runtime'), root = join(base, 'project'); fs.mkdirSync(root);
  const file = join(root, 'owned.txt'); fs.writeFileSync(file, text);
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(base, 'config.json'), waitMs: 20 });
  const admin = async (path, data) => {
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}/${path}`, {
      method: 'POST', headers: { authorization: 'Bearer ' + worker.key }, body: JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  const registered = await admin('register', { id: 'owned', instructions: 'owned fixture',
    inputs: { supplied: text, empty: '', nul: '\0' }, workspace: { root, mode } });
  assert.equal(registered.status, 200);
  const token = registered.value.token;
  // Capture the actual HTTP JSON bytes as well as its parsed value.
  const rpc = async (method, params, version) => {
    const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', headers: version ? { 'mcp-protocol-version': version } : {},
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    assert.equal(response.status, 200);
    const wire = await response.text(), parsed = JSON.parse(wire);
    assert.equal(parsed.error, undefined);
    return { result: parsed.result, wire };
  };
  const call = (name, args = {}, version) => rpc('tools/call', { name, arguments: { token, ...args } }, version);
  return { dir, root, file, token, admin, rpc, call };
}
function data(reply) {
  assert.equal(reply.result.isError, false, reply.wire);
  return JSON.parse(reply.result.content[0].text);
}

test('real worker advertises opt-in only on the two read tools and keeps seven tools', async t => {
  const f = await fixture(t), { result } = await f.rpc('tools/list', {});
  assert.deepEqual(result.tools.map(tool => tool.name), ['list_files', 'read_file', 'write_file', 'delete_file', 'get_task', 'read_input', 'submit_result']);
  for (const tool of result.tools) {
    const rule = tool.inputSchema.properties.responseFormat;
    if (['read_file', 'read_input'].includes(tool.name)) {
      assert.deepEqual(rule, { type: 'string', enum: ['dual', 'text'] });
      assert.equal(tool.inputSchema.required.includes('responseFormat'), false);
    } else assert.equal(rule, undefined);
    assert.equal(tool.outputSchema, undefined, 'text-only results must not contradict a structured output requirement');
  }
});

for (const version of protocol.protocolVersions) test(`real worker ${version} preserves full, window, empty and missing read values in text mode`, async t => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.root, 'empty.txt'), '');
  const state = fs.readFileSync(join(f.dir, 'state.json'));
  for (const [name, args] of [
    ['read_file', { path: 'owned.txt' }], ['read_file', { path: 'owned.txt', limit: 1, expectedSha256: digest(text) }],
    ['read_file', { path: 'empty.txt' }], ['read_file', { path: 'missing.txt' }],
    ['read_input', { name: 'supplied' }], ['read_input', { name: 'supplied', limit: 1 }],
    ['read_input', { name: 'empty' }], ['read_input', { name: 'nul' }],
  ]) {
    const dual = await f.call(name, args, version), single = await f.call(name, { ...args, responseFormat: 'text' }, version);
    assert.deepEqual(data(single), data(dual));
    assert.deepEqual(data(dual), dual.result.structuredContent);
    assert.equal(Object.hasOwn(single.result, 'structuredContent'), false);
    assert.ok(Buffer.byteLength(single.wire) < Buffer.byteLength(dual.wire));
    assert.deepEqual((await f.call(name, { ...args, responseFormat: 'dual' }, version)).result, dual.result);
  }
  assert.equal(data(await f.call('read_file', { path: 'owned.txt' }, version)).text, text, 'opt-in does not persist');
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), state);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
});

test('real worker rejects bad response formats before source reads and keeps error and grant gates', async t => {
  const f = await fixture(t, 'read'), state = fs.readFileSync(join(f.dir, 'state.json'));
  const observed = observeFileRead(t, f.file);
  try {
    for (const responseFormat of [null, true, 0, [], {}, '', 'TEXT', 'structured']) {
      const reply = await f.call('read_file', { path: 'owned.txt', responseFormat });
      assert.equal(reply.result.isError, true); assert.equal(reply.result.structuredContent, undefined);
    }
  } finally { observed.restore(); }
  assert.equal(observed.evidence.opens, 0); assert.equal(observed.evidence.bytes, 0);
  for (const [name, args] of [
    ['read_file', { path: 'owned.txt', expectedSha256: '0'.repeat(64) }],
    ['read_file', { path: '../outside' }], ['read_file', { path: 'owned.txt', limit: 0 }],
    ['read_file', { path: 'owned.txt', token: 'wrong' }], ['read_input', { name: 'missing' }],
  ]) {
    const ordinary = await f.call(name, args), single = await f.call(name, { ...args, responseFormat: 'text' });
    assert.equal(single.result.isError, true); assert.deepEqual(single.result, ordinary.result);
  }
  for (const name of ['write_file', 'delete_file']) {
    const args = { path: 'owned.txt', expectedSha256: digest(text), ...(name === 'write_file' ? { text: 'changed' } : {}) };
    assert.equal((await f.call(name, { ...args, responseFormat: 'text' })).result.isError, true);
    assert.equal((await f.call(name, args)).result.isError, true, 'read-only scope still forbids mutations');
  }
  assert.equal((await f.call('get_task', { responseFormat: 'text' })).result.isError, true);
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), state);
  assert.equal(fs.readFileSync(f.file, 'utf8'), text);
});

test('real worker rechecks original bytes before later edits, completion and collection', async t => {
  const f = await fixture(t);
  const edited = data(await f.call('write_file', { path: 'owned.txt', expectedSha256: digest(text), text: 'changed' }));
  const originalStat = fs.statSync(edited.backup), changed = Buffer.from(text); changed[changed.length - 1] = 0x78;
  fs.writeFileSync(edited.backup, changed); fs.utimesSync(edited.backup, originalStat.atime, originalStat.mtime);
  const state = fs.readFileSync(join(f.dir, 'state.json'));
  for (const [name, args] of [
    ['write_file', { path: 'owned.txt', expectedSha256: digest('changed'), text: 'must not apply' }],
    ['delete_file', { path: 'owned.txt', expectedSha256: digest('changed') }],
    ['submit_result', { status: 'completed', summary: 'done', result: 'done' }],
  ]) {
    const reply = await f.call(name, args);
    assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, /recovery required/);
  }
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), state);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'changed');
  assert.deepEqual(fs.readFileSync(edited.backup), changed);
  data(await f.call('submit_result', { status: 'failed', summary: 'preserved', result: 'partial evidence' }));
  const beforeCollection = fs.readFileSync(join(f.dir, 'state.json'));
  const collection = await f.admin('collect', { id: 'owned', expectedStatus: 'failed', expectedSha256: digest('partial evidence') });
  assert.equal(collection.status, 409); assert.equal(collection.value.code, 'COLLECTION_RECOVERY_REQUIRED');
  assert.deepEqual(fs.readFileSync(join(f.dir, 'state.json')), beforeCollection);
  assert.equal(data(await f.call('get_task')).status, 'failed', 'blocked collection retains token and task evidence');
});
