import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { dispatchCli, dispatchDiagnostic, registerDispatch, textDigest } from './dispatch.mjs';

const secret = 'PRIVATE-cli-token-prompt-path';
const prompt = `Review the supplied evidence: ${secret}`;
const target = { tabId: 'private-tab', chatUrl: 'https://chatgpt.com/c/private-chat' };
const spec = (attachments = false) => ({ taskId: 'cli-task', mode: 'pro', prompt, target,
  ...(attachments ? { requiredAttachments: ['private-source.txt'] } : {}) });
const ready = () => ({ target, mode: 'pro', connectorSelected: true, approvalPending: false,
  composerSha256: null, lastUserMessageId: 'private-previous' });
const sent = (attachments = false) => ({ ...ready(), lastUserMessageId: 'private-new', userMessage: {
  id: 'private-new', previousId: 'private-previous', role: 'user', bodySha256: textDigest(prompt),
  ...(attachments ? { attachmentNames: ['private-source.txt'] } : {}),
} });
const fixture = t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json'), payload = join(dir, secret + '.json');
  fs.writeFileSync(file, JSON.stringify({ token: secret, ownership: 'preserve' }));
  return { dir, file, payload };
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const safe = (value, f) => {
  const text = JSON.stringify(value);
  for (const privateValue of [secret, prompt, target.tabId, target.chatUrl, 'private-new',
    'private-previous', 'private-source.txt', textDigest(prompt), f.file, f.payload])
    assert.equal(text.includes(privateValue), false, 'private data in compact output');
  return value;
};
const inputFailure = (f, stage, reason, code = 'DISPATCH_INPUT') => error => {
  const value = safe(dispatchDiagnostic(error), f);
  assert.deepEqual(Object.keys(value), ['code', 'stage', 'reason', 'message']);
  assert.equal(value.code, code); assert.equal(value.stage, stage); assert.equal(value.reason, reason);
  return true;
};
const payloadActions = ['register', 'prepare', 'begin', 'confirm'];

for (const [action, count] of Object.entries({ preflight: 1, inspect: 2, recover: 2, register: 3, prepare: 3, begin: 3, confirm: 3 }))
  test(`CLI ${action} diagnoses arity before payload or ledger access`, async t => {
    const f = fixture(t), original = fs.lstatSync;
    const normal = [action, f.file, f.payload].slice(0, count);
    let accesses = 0;
    fs.lstatSync = () => { accesses++; throw Error(secret); }; syncBuiltinESMExports();
    try {
      // Even preflight's extra arguments must be rejected without reading them.
      if (count > 1) await assert.rejects(dispatchCli(normal.slice(0, -1)), inputFailure(f, 'cli_arguments', action + '_arguments_invalid'));
      await assert.rejects(dispatchCli([...normal, secret]), inputFailure(f, 'cli_arguments', action + '_arguments_invalid'));
    } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
    assert.equal(accesses, 0);
    assert.equal(read(f.file).ownership, 'preserve');
    assert.deepEqual(fs.readdirSync(f.dir), ['ledger.json']);
  });

test('CLI rejects non-string vectors and unknown/prototype actions without echoing them', async t => {
  const f = fixture(t);
  for (const args of [null, {}, [], ['begin', f.file, null], Array(2)])
    await assert.rejects(dispatchCli(args), inputFailure(f, 'cli_arguments', 'invalid_arguments'));
  for (const action of [secret, '__proto__', 'constructor', 'toString', ''])
    await assert.rejects(dispatchCli([action, f.file, f.payload]), inputFailure(f, 'cli_arguments', 'unknown_action'));
  assert.deepEqual(fs.readdirSync(f.dir), ['ledger.json']);
});

for (const action of payloadActions) test(`CLI ${action} distinguishes paths, missing payload, UTF-8 and JSON without changing the ledger`, async t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  await assert.rejects(dispatchCli([action, 'relative.json', f.payload]), inputFailure(f, 'cli_arguments', action + '_ledger_path_invalid'));
  await assert.rejects(dispatchCli([action, f.file, 'relative.json']), inputFailure(f, 'cli_arguments', action + '_payload_path_invalid'));
  await assert.rejects(dispatchCli([action, f.file, f.payload]), inputFailure(f, 'payload_read', action + '_payload_missing'));
  for (const [bytes, suffix] of [[Buffer.from([0xff]), 'payload_utf8_invalid'], [Buffer.from('{"secret":"' + secret), 'payload_json_invalid']]) {
    fs.writeFileSync(f.payload, bytes);
    await assert.rejects(dispatchCli([action, f.file, f.payload]), inputFailure(f, 'payload_decode', action + '_' + suffix));
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readFileSync(f.payload), bytes);
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
  }
});

for (const kind of ['directory', 'hardlink', 'oversized']) test(`CLI payload ${kind} is not mislabeled as a corrupt task ledger`, async t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  if (kind === 'directory') fs.mkdirSync(f.payload);
  else if (kind === 'hardlink') fs.linkSync(f.file, f.payload);
  else fs.writeFileSync(f.payload, Buffer.alloc(2 * 1024 * 1024 + 1, 32));
  await assert.rejects(dispatchCli(['begin', f.file, f.payload]), inputFailure(f, 'payload_read', 'begin_payload_file_invalid'));
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
});

for (const action of ['register', 'begin']) test(`CLI ${action} rejects wrong routing envelopes before any ledger write`, async t => {
  const f = fixture(t), before = fs.readFileSync(f.file), original = fs.openSync;
  const invalid = [null, [], {}, ready(), { prompt, observation: ready(), token: secret }];
  let writes = 0;
  fs.openSync = (path, flags, ...rest) => {
    if (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) writes++;
    return original(path, flags, ...rest);
  }; syncBuiltinESMExports();
  try {
    for (const value of invalid) {
      // Use the original descriptor creator for the test input, not the observed dispatch writes.
      const fd = original(f.payload, 'w');
      try { fs.writeFileSync(fd, JSON.stringify(value)); } finally { fs.closeSync(fd); }
      await assert.rejects(dispatchCli([action, f.file, f.payload]), inputFailure(f, 'payload_validate', action + '_input_shape_invalid'));
    }
  } finally { fs.openSync = original; syncBuiltinESMExports(); }
  assert.equal(writes, 0); assert.deepEqual(fs.readFileSync(f.file), before);
});

test('CLI value diagnostics retain trusted error identity and do not reclassify storage, locks or ledger corruption', async t => {
  const f = fixture(t);
  await registerDispatch(f.file, spec());
  fs.writeFileSync(f.payload, JSON.stringify({ prompt, observation: { ...ready(), token: secret } }));
  let failure;
  try { await dispatchCli(['begin', f.file, f.payload]); } catch (error) { failure = error; }
  inputFailure(f, 'payload_validate', 'begin_input_invalid', 'DISPATCH_OBSERVATION')(failure);
  const trusted = dispatchDiagnostic(failure);
  Object.assign(failure, { code: secret, stage: secret, reason: secret, message: secret });
  assert.deepEqual(dispatchDiagnostic(failure), trusted);
  assert.equal(dispatchDiagnostic({ ...trusted }).code, 'DISPATCH_INTERNAL');
  fs.writeFileSync(f.payload, JSON.stringify({ prompt, observation: ready() }));
  const lock = f.file + '.dispatch.lock'; fs.writeFileSync(lock, secret);
  await assert.rejects(dispatchCli(['begin', f.file, f.payload]), inputFailure(f, 'lock_acquire', 'lock_exists', 'DISPATCH_LOCKED'));
  assert.equal(fs.readFileSync(lock, 'utf8'), secret); fs.unlinkSync(lock);
  fs.writeFileSync(f.file, '{"dispatch":null}');
  await assert.rejects(dispatchCli(['begin', f.file, f.payload]), inputFailure(f, 'ledger_validate', 'invalid_ledger', 'DISPATCH_LEDGER'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"dispatch":null}');
});

// Fresh ordinary Node processes call the actual dispatcher; these are UI fixtures,
// not real browser submissions. The existing dispatch.test.mjs also tests client.mjs.
function cli(args) {
  const source = `import {dispatchCli, dispatchDiagnostic} from ${JSON.stringify(new URL('./dispatch.mjs', import.meta.url).href)};
    try { console.log(JSON.stringify(await dispatchCli(process.argv.slice(1)))); }
    catch (error) { console.error(JSON.stringify(dispatchDiagnostic(error))); process.exitCode = 1; }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, '--', ...args], { timeout: 15000, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.once('error', reject);
    child.once('close', code => {
      try { resolve({ code, out, err, value: JSON.parse(code === 0 ? out : err) }); } catch (error) { reject(error); }
    });
  });
}

for (const attachments of [false, true]) test(`CLI v${attachments ? 2 : 1} sequential begin, competing begin, incomplete evidence and late confirm preserve contracts`, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.payload, '\ufeff' + JSON.stringify(spec(attachments)));
  const registered = await cli(['register', f.file, f.payload]);
  assert.equal(registered.code, 0, registered.err); safe(registered.value, f);
  const expectedKeys = ['state', 'mode', 'connectorRequired', 'uiPrepared', 'submissionConfirmed', 'resendBlocked', 'needsInspection', 'reason',
    ...(attachments ? ['requiredAttachmentCount', 'attachmentEvidenceConfirmed'] : [])];
  assert.deepEqual(Object.keys(registered.value), expectedKeys);
  fs.writeFileSync(f.payload, JSON.stringify({ prompt, observation: ready() }));
  const begins = await Promise.all([cli(['begin', f.file, f.payload]), cli(['begin', f.file, f.payload])]);
  assert.equal(begins.filter(value => value.code === 0).length, 1);
  assert.ok(begins.filter(value => value.code !== 0).every(value => ['DISPATCH_LOCKED', 'DISPATCH_BLOCKED'].includes(value.value.code)));
  const sending = fs.readFileSync(f.file);
  fs.writeFileSync(f.payload, '{"bad":"' + secret);
  const invalid = await cli(['confirm', f.file, f.payload]);
  assert.equal(invalid.code, 1); assert.equal(invalid.value.reason, 'confirm_payload_json_invalid'); safe(invalid.value, f);
  assert.deepEqual(fs.readFileSync(f.file), sending);
  // Decodable null/wrong/incomplete evidence must still record uncertain, not become a new CLI rejection.
  for (const incomplete of [null, {}, attachments ? sent(false) : { ...sent(), userMessage: { ...sent().userMessage, bodySha256: textDigest('different') } }]) {
    fs.writeFileSync(f.payload, JSON.stringify(incomplete));
    const result = await cli(['confirm', f.file, f.payload]);
    assert.equal(result.code, 0, result.err); assert.equal(result.value.state, 'uncertain');
    assert.equal(result.value.reason, 'evidence_unconfirmed'); assert.equal(result.value.resendBlocked, true);
    assert.equal(result.value.submissionConfirmed, false); safe(result.value, f);
  }
  fs.writeFileSync(f.payload, JSON.stringify({ prompt, observation: ready() }));
  assert.equal((await cli(['begin', f.file, f.payload])).value.code, 'DISPATCH_BLOCKED');
  fs.writeFileSync(f.payload, JSON.stringify(sent(attachments)));
  const confirmed = await cli(['confirm', f.file, f.payload]);
  assert.equal(confirmed.code, 0, confirmed.err); assert.equal(confirmed.value.submissionConfirmed, true);
  assert.deepEqual(Object.keys(safe(confirmed.value, f)), expectedKeys);
  const submitted = fs.readFileSync(f.file);
  assert.deepEqual((await cli(['confirm', f.file, f.payload])).value, confirmed.value);
  assert.deepEqual(fs.readFileSync(f.file), submitted);
  fs.writeFileSync(f.payload, 'null');
  assert.equal((await cli(['confirm', f.file, f.payload])).value.code, 'DISPATCH_BLOCKED');
  assert.deepEqual(fs.readFileSync(f.file), submitted);
  assert.equal(read(f.file).dispatch.version, attachments ? 2 : 1);
  assert.equal(read(f.file).token, secret);
});

for (const recovery of [false, true]) test(`CLI uncertain dispatch collection ${recovery ? 'refuses recovery evidence' : 'retires the token without inventing UI confirmation'}`, async t => {
  const { start } = await import('./worker.mjs');
  const { request } = await import('./client.mjs');
  const f = fixture(t), dir = join(f.dir, 'runtime');
  const worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20, closeGraceMs: 50, configFile: join(f.dir, 'config.json') });
  try {
    const config = { dataDir: dir, controlPort: worker.controlPort };
    const registered = await request('register', { id: 'cli-task', instructions: 'fixture', inputs: {} }, config);
    const call = async (name, args) => (await (await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })).json()).result;
    fs.writeFileSync(f.payload, JSON.stringify(spec(true))); await dispatchCli(['register', f.file, f.payload]);
    fs.writeFileSync(f.payload, JSON.stringify({ prompt, observation: ready() })); await dispatchCli(['begin', f.file, f.payload]);
    fs.writeFileSync(f.payload, JSON.stringify(sent(false)));
    assert.equal((await dispatchCli(['confirm', f.file, f.payload])).state, 'uncertain');
    const before = fs.readFileSync(f.file);
    const result = await call('submit_result', { token: registered.token, status: 'completed', summary: 'fixture', result: 'saved evidence' });
    assert.equal(result.isError, false);
    const collect = () => request('collect', { id: 'cli-task', expectedStatus: 'completed', expectedSha256: result.structuredContent.sha256 }, config);
    if (recovery) {
      const directory = join(dir, 'recovery', 'cli-task'); fs.mkdirSync(directory, { recursive: true });
      const journal = join(directory, randomUUID() + '.json'); fs.writeFileSync(journal, '{"state":"prepared"}');
      await assert.rejects(collect(), error => error.code === 'COLLECTION_RECOVERY_REQUIRED');
      assert.equal(fs.readFileSync(journal, 'utf8'), '{"state":"prepared"}');
      assert.equal((await call('get_task', { token: registered.token })).isError, false);
    } else {
      assert.equal((await collect()).collected, true);
      assert.equal((await call('get_task', { token: registered.token })).isError, true);
    }
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal((await dispatchCli(['inspect', f.file])).submissionConfirmed, false);
  } finally { await worker.close(); }
});
