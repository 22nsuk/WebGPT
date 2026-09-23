import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, linkSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { registerDispatch, prepareDispatch, beginDispatch, confirmDispatch, dispatchPrompt,
  inspectDispatch, recoverDispatch, textDigest, dispatchCli, preflightDispatchRuntime, dispatchDiagnostic } from './dispatch.mjs';

const secret = 'PRIVATE-PROMPT-and-task-token-should-never-escape';
const prompt = `연결 효율화 검토 🧪\r\n${secret}`;
const target = { tabId: 'private-tab-id', chatUrl: 'https://chatgpt.com/c/private-conversation-id' };
const spec = () => ({ taskId: 'test-task', mode: 'pro', prompt, target: { ...target } });
const ready = () => ({ target: { ...target }, mode: 'pro', connectorSelected: true, approvalPending: false,
  composerSha256: null, lastUserMessageId: 'previous-user-message' });
const sent = () => ({ ...ready(), lastUserMessageId: 'new-user-message', userMessage: {
  id: 'new-user-message', previousId: 'previous-user-message', role: 'user', bodySha256: textDigest(prompt),
} });
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-dispatch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'ledger.json') };
};
const safe = value => {
  const text = JSON.stringify(value);
  for (const privateText of [secret, target.tabId, target.chatUrl, 'previous-user-message', 'new-user-message', textDigest(prompt)])
    assert.ok(!text.includes(privateText), 'public output contains private data');
  return value;
};
const adapter = (overrides = {}) => ({ observeReady: async () => ready(), fillAndSend: async () => {}, observeSent: async () => sent(), ...overrides });
const summaryKeys = ['state', 'mode', 'connectorRequired', 'uiPrepared', 'submissionConfirmed', 'resendBlocked', 'needsInspection', 'reason'];

test('runtime preflight is compact and independent of private files', async () => {
  assert.deepEqual(preflightDispatchRuntime(), { runtime: 'node', ready: true });
  assert.deepEqual(await dispatchCli(['preflight']), { runtime: 'node', ready: true });
  await assert.rejects(dispatchCli(['preflight', 'unexpected']), { code: 'DISPATCH_INPUT' });
});

test('missing process is diagnosed before any ledger, payload or browser access', async t => {
  const { file } = fixture(t);
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { preflightDispatchRuntime, registerDispatch, dispatchPrompt, dispatchCli, dispatchDiagnostic } from ${JSON.stringify(moduleUrl)};
    const file = process.argv[1];
    let accesses = 0;
    for (const method of ['lstatSync', 'readFileSync', 'realpathSync', 'writeFileSync', 'openSync', 'readSync', 'fstatSync', 'fsyncSync', 'closeSync'])
      fs[method] = () => { accesses++; throw Error(${JSON.stringify(secret)}); };
    syncBuiltinESMExports();
    delete globalThis.process;
    for (const operation of [() => preflightDispatchRuntime(), () => registerDispatch(file, {}),
      () => dispatchPrompt(file, '', {}), () => dispatchCli(['register', file, file])]) {
      try { await operation(); assert.fail('operation must reject'); }
      catch (error) { assert.equal(error.code, 'DISPATCH_RUNTIME'); console.log(JSON.stringify(dispatchDiagnostic(error))); }
    }
    assert.equal(accesses, 0);
  `, file], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const errors = safe(run.stdout).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(errors.length, 4);
  for (const error of errors) assert.deepEqual(error, {
    code: 'DISPATCH_RUNTIME', stage: 'runtime_preflight', reason: 'node_cli_required',
    message: 'dispatch requires ordinary Node CLI; keep browser operations in authorized browser tools',
  });
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(file + '.dispatch.lock'), false);
});

for (const [stage, method, predicate, code, reason] of [
  ['ledger_path', 'realpathSync', 'true', 'DISPATCH_STORAGE', 'permission_denied'],
  ['lock_acquire', 'openSync', "args[0].endsWith('.dispatch.lock')", 'DISPATCH_STORAGE', 'permission_denied'],
  ['ledger_read', 'openSync', "args[0].endsWith('ledger.json')", 'DISPATCH_STORAGE', 'permission_denied'],
  ['ledger_write', 'openSync', "args[0].includes('.tmp-')", 'DISPATCH_STORAGE', 'permission_denied'],
  ['ledger_publish', 'renameSync', 'true', 'DISPATCH_STORAGE', 'permission_denied'],
  ['ledger_write', 'fsyncSync', '++calls === 2', 'DISPATCH_STORAGE', 'permission_denied'],
  ['lock_release', 'unlinkSync', "args[0].endsWith('.dispatch.lock')", 'DISPATCH_LOCKED', 'lock_release_failed'],
]) test('storage diagnostics bound and identify ' + stage + ' via ' + method, async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { prepareDispatch, dispatchDiagnostic } from ${JSON.stringify(moduleUrl)};
    const original = fs[${JSON.stringify(method)}];
    let calls = 0;
    fs[${JSON.stringify(method)}] = (...args) => {
      if (${predicate}) throw Object.assign(Error(${JSON.stringify(secret + target.chatUrl)}), { code: 'EACCES', path: process.argv[1] });
      return original(...args);
    };
    syncBuiltinESMExports();
    try { await prepareDispatch(process.argv[1], ${JSON.stringify(ready())}); }
    catch (error) { console.log(JSON.stringify(dispatchDiagnostic(error))); }
  `, file], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  const diagnostic = safe(JSON.parse(run.stdout));
  assert.deepEqual(Object.keys(diagnostic), ['code', 'stage', 'reason', 'message']);
  assert.equal(diagnostic.code, code);
  assert.equal(diagnostic.stage, stage);
  assert.equal(diagnostic.reason, reason);
  assert.ok(!run.stdout.includes(file));
});

test('unexpected caller failures and forged diagnostics never masquerade as storage or leak exceptions', async t => {
  const { file } = fixture(t);
  const input = spec();
  Object.defineProperty(input, 'prompt', { enumerable: true, get() { throw Error(secret); } });
  let failure;
  try { await registerDispatch(file, input); } catch (error) { failure = error; }
  const diagnostic = dispatchDiagnostic(failure);
  assert.equal(diagnostic.code, 'DISPATCH_INTERNAL');
  assert.equal(diagnostic.stage, 'ledger_update');
  assert.equal(diagnostic.reason, 'unexpected_failure');
  Object.assign(failure, { code: secret, stage: secret, reason: secret, message: secret });
  assert.deepEqual(safe(dispatchDiagnostic(failure)), diagnostic);
  for (const forged of [Error(secret), { code: 'DISPATCH_STORAGE', stage: secret, reason: secret, message: secret }, null])
    assert.deepEqual(safe(dispatchDiagnostic(forged)), diagnostic);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(file + '.dispatch.lock'), false);
});

test('a missing parent directory reports a fixed reason without leaking its path', async t => {
  const { dir } = fixture(t);
  const file = join(dir, secret, 'ledger.json');
  await assert.rejects(registerDispatch(file, spec()), error => {
    const diagnostic = safe(dispatchDiagnostic(error));
    assert.equal(diagnostic.code, 'DISPATCH_STORAGE');
    assert.equal(diagnostic.stage, 'ledger_path');
    assert.equal(diagnostic.reason, 'not_found');
    return true;
  });
});

test('payload read failures use only allowlisted reasons, including unknown secret error codes', async t => {
  const { dir, file } = fixture(t);
  const input = join(dir, 'input.json');
  writeFileSync(input, JSON.stringify(spec()));
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  for (const [errorCode, reason] of [['ENOSPC', 'storage_full'], ['EPERM', 'permission_denied'], [secret, 'io_failed']]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { dispatchCli, dispatchDiagnostic } from ${JSON.stringify(moduleUrl)};
      fs.openSync = () => { throw Object.assign(Error(${JSON.stringify(secret)}), { code: ${JSON.stringify(errorCode)} }); };
      syncBuiltinESMExports();
      try { await dispatchCli(['register', process.argv[1], process.argv[2]]); }
      catch (error) { console.log(JSON.stringify(dispatchDiagnostic(error))); }
    `, file, input], { encoding: 'utf8', timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(safe(JSON.parse(run.stdout)), {
      code: 'DISPATCH_STORAGE', stage: 'payload_read', reason,
      message: 'dispatch storage unavailable; inspect private files',
    });
    assert.ok(!run.stdout.includes(input));
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(file + '.dispatch.lock'), false);
  }
});

test('extends the existing ledger without copying task completion authority', async t => {
  const { file } = fixture(t);
  const prior = { taskId: 'test-task', objective: secret, ownership: { tabs: [target.tabId] }, work: 'RUNNING', cleanup: 'PENDING' };
  writeFileSync(file, JSON.stringify(prior));
  assert.equal(safe(await registerDispatch(file, spec())).state, 'registered');
  const saved = read(file);
  assert.deepEqual(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'dispatch')), prior);
  assert.equal(saved.dispatch.promptSha256, textDigest(prompt));
  assert.equal(saved.dispatch.target.chatUrl, target.chatUrl);
  assert.ok(!JSON.stringify(saved.dispatch).includes(secret));
  const bytes = readFileSync(file);
  await registerDispatch(file, spec());
  assert.deepEqual(readFileSync(file), bytes);
  await assert.rejects(registerDispatch(file, { ...spec(), prompt: 'different body' }), { code: 'DISPATCH_CONFLICT' });
  if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o600);
});

test('saves sending before side effects, confirms only a matching new user message', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  let sends = 0;
  const result = await dispatchPrompt(file, prompt, adapter({ fillAndSend: async body => {
    assert.equal(body, prompt);
    assert.equal(read(file).dispatch.state, 'sending');
    assert.ok(read(file).dispatch.sendingAt);
    assert.ok(existsSync(file + '.dispatch.lock'));
    sends++;
  } }));
  assert.equal(result.state, 'submitted');
  assert.deepEqual(Object.keys(safe(result)), summaryKeys);
  assert.equal(sends, 1);
  assert.equal(safe(await confirmDispatch(file, sent())).state, 'submitted');
  await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_BLOCKED' });
  // Even an identical controller/parent registration cannot reopen an attempted transmission.
  assert.equal((await registerDispatch(file, spec())).state, 'submitted');
  assert.equal((await recoverDispatch(file)).state, 'submitted');
});

test('same-ledger concurrent callers cannot both invoke the browser', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const first = dispatchPrompt(file, prompt, adapter({ fillAndSend: async () => { calls++; started(); await gate; } }));
  await entered;
  try {
    await assert.rejects(dispatchPrompt(file, prompt, adapter({ fillAndSend: async () => { calls++; } })), { code: 'DISPATCH_LOCKED' });
    await assert.rejects(recoverDispatch(file), { code: 'DISPATCH_LOCKED' });
  } finally { release(); }
  assert.equal((await first).state, 'submitted');
  assert.equal(calls, 1);
});

test('lost send response and partial typing never trigger an automatic retry', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  let draft = '', calls = 0, confirmations = 0;
  const result = await dispatchPrompt(file, prompt, adapter({
    fillAndSend: async () => { draft = prompt.slice(0, 7); calls++; throw Error(secret + target.chatUrl); },
    observeSent: async () => { confirmations++; return sent(); },
  }));
  assert.equal(safe(result).state, 'uncertain');
  assert.equal(result.reason, 'send_unconfirmed');
  assert.equal(read(file).dispatch.state, 'uncertain');
  await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_BLOCKED' });
  assert.equal(calls, 1);
  assert.equal(confirmations, 0);
  assert.equal(draft, prompt.slice(0, 7));
  // A separate, explicit inspection can establish that the original send actually succeeded.
  assert.equal((await confirmDispatch(file, sent())).state, 'submitted');
});

test('an unavailable post-send observation is persisted as uncertain without its raw error', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const result = await dispatchPrompt(file, prompt, adapter({ observeSent: async () => { throw Error(secret); } }));
  assert.equal(safe(result).reason, 'observation_unavailable');
  assert.ok(!readFileSync(file, 'utf8').includes(secret));
});

test('split CLI flow persists sending across a fresh process and recover never resends', async t => {
  const { file, dir } = fixture(t);
  await registerDispatch(file, spec());
  await beginDispatch(file, { prompt, observation: ready() });
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { dispatchPrompt, recoverDispatch } from ${JSON.stringify(moduleUrl)};
    try { await dispatchPrompt(process.argv[1], 'not re-sent', {
      observeReady: async () => { throw Error('BROWSER_CALLED'); },
      fillAndSend: async () => { throw Error('BROWSER_CALLED'); }, observeSent: async () => {} });
    } catch (error) { console.log(error.code); }
    console.log(JSON.stringify(await recoverDispatch(process.argv[1])));
  `, file], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DISPATCH_BLOCKED/);
  assert.doesNotMatch(run.stdout + run.stderr, /BROWSER_CALLED/);
  safe(run.stdout);
  assert.equal(read(file).dispatch.state, 'uncertain');
  assert.equal((await recoverDispatch(file)).reason, 'interrupted');
});

const wrongEvidence = [
  ['old message', o => { o.userMessage.id = o.lastUserMessageId = 'previous-user-message'; }],
  ['unrelated prior message', o => { o.userMessage.previousId = 'another-old-message'; }],
  ['different body', o => { o.userMessage.bodySha256 = textDigest('another body'); }],
  ['assistant text', o => { o.userMessage.role = 'assistant'; }],
  ['another tab', o => { o.target.tabId = 'unowned-tab'; }],
  ['another chat', o => { o.target.chatUrl = 'https://chatgpt.com/c/unowned-chat'; }],
  ['URL not yet known', o => { o.target.chatUrl = null; }],
  ['mode mismatch', o => { o.mode = 'xhigh'; }],
  ['connector lost', o => { o.connectorSelected = false; }],
  ['approval pending', o => { o.approvalPending = true; }],
  ['draft not cleared', o => { o.composerSha256 = textDigest(prompt); }],
  ['no actual message evidence', o => { delete o.userMessage; }],
  ['message not newest', o => { o.lastUserMessageId = 'some-other-message'; }],
  ['raw transcript', o => { o.transcript = secret; }],
  ['raw nested text', o => { o.userMessage.text = secret; }],
];
for (const [label, mutate] of wrongEvidence) test('does not confirm from ' + label, async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  await beginDispatch(file, { prompt, observation: ready() });
  const observed = sent();
  mutate(observed);
  assert.equal(safe(await confirmDispatch(file, observed)).state, 'uncertain');
  assert.equal(read(file).dispatch.state, 'uncertain');
  await assert.rejects(beginDispatch(file, { prompt, observation: ready() }), { code: 'DISPATCH_BLOCKED' });
});

const notReady = [
  ['unapproved UI', o => { o.approvalPending = true; }],
  ['wrong mode', o => { o.mode = 'xhigh'; }],
  ['missing connector', o => { o.connectorSelected = false; }],
  ['partial draft', o => { o.composerSha256 = textDigest('partial'); }],
  ['wrong target', o => { o.target.tabId = 'not-owned'; }],
  ['extra observation data', o => { o.sidebar = secret; }],
];
for (const [label, mutate] of notReady) test('no send for ' + label, async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const observed = ready();
  mutate(observed);
  let sends = 0;
  await assert.rejects(dispatchPrompt(file, prompt, adapter({ observeReady: async () => observed, fillAndSend: async () => { sends++; } })),
    error => { safe({ message: error.message, code: error.code }); return /^DISPATCH_/.test(error.code); });
  assert.equal(sends, 0);
  assert.equal(read(file).dispatch.state, 'registered');
});

test('blank and connector-only bodies are rejected; Unicode/newlines preserve the visible body', async t => {
  const { file } = fixture(t);
  for (const body of ['', '\n ', '@WebGPT Worker', 'WebGPT Worker', '\ud800']) {
    await assert.rejects(registerDispatch(file, { ...spec(), prompt: body }), { code: 'DISPATCH_INPUT' });
    assert.equal(existsSync(file), false);
  }
  assert.equal(textDigest(prompt), textDigest(prompt.replace(/\r\n/g, '\n')));
  await registerDispatch(file, spec());
  const observed = ready();
  observed.composerSha256 = textDigest(prompt);
  assert.equal((await prepareDispatch(file, observed)).state, 'prepared');
});

test('a new owned chat records its actual URL only with fresh message evidence', async t => {
  const { file } = fixture(t);
  const initial = spec(); initial.target.chatUrl = null;
  await registerDispatch(file, initial);
  const before = ready(); before.target.chatUrl = null; before.lastUserMessageId = null;
  const after = sent(); after.userMessage.previousId = null;
  assert.equal((await dispatchPrompt(file, prompt, adapter({ observeReady: async () => before, observeSent: async () => after }))).state, 'submitted');
  assert.equal(read(file).dispatch.confirmation.target.chatUrl, target.chatUrl);
});

test('stored readiness is detached from caller-owned objects', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const before = ready();
  const result = await dispatchPrompt(file, prompt, adapter({ observeReady: async () => before,
    fillAndSend: async () => { before.lastUserMessageId = 'tampered'; before.target.tabId = 'tampered'; } }));
  assert.equal(result.state, 'submitted');
});

test('malformed, linked or incompatible ledgers fail closed without overwriting', async t => {
  const { file, dir } = fixture(t);
  for (const bytes of [Buffer.from('{"private":"' + secret), Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('{"dispatch":null}')]) {
    writeFileSync(file, bytes);
    await assert.rejects(registerDispatch(file, spec()), { code: 'DISPATCH_LEDGER' });
    assert.deepEqual(readFileSync(file), bytes);
  }
  rmSync(file);
  const original = join(dir, 'original.json'); writeFileSync(original, '{}');
  linkSync(original, file);
  await assert.rejects(registerDispatch(file, spec()), { code: 'DISPATCH_LEDGER' });
  assert.equal(readFileSync(original, 'utf8'), '{}');
  rmSync(file);
  try { symlinkSync(original, file); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.diagnostic('symlink privilege unavailable; hardlink case passed');
    throw error;
  }
  await assert.rejects(registerDispatch(file, spec()), { code: 'DISPATCH_LEDGER' });
  assert.equal(readFileSync(original, 'utf8'), '{}');
});

test('stale locks are preserved; there is no age-based recovery or unsafe reinitialization', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const lock = file + '.dispatch.lock';
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, createdAt: '2000-01-01' }));
  await assert.rejects(recoverDispatch(file), { code: 'DISPATCH_LOCKED' });
  await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_LOCKED' });
  assert.ok(existsSync(lock));
});

test('a concurrent external ledger edit is not overwritten by confirmation', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  await assert.rejects(dispatchPrompt(file, prompt, adapter({ fillAndSend: async () => {
    const changed = read(file); changed.operatorNote = 'preserve'; writeFileSync(file, JSON.stringify(changed));
  } })), { code: 'DISPATCH_CONFLICT' });
  assert.equal(read(file).operatorNote, 'preserve');
  assert.equal(read(file).dispatch.state, 'sending');
  assert.equal((await recoverDispatch(file)).state, 'uncertain');
});

test('failure publishing sending prevents the browser call', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  let calls = 0;
  await assert.rejects(dispatchPrompt(file, prompt, adapter({ observeReady: async () => {
    const changed = read(file); changed.external = true; writeFileSync(file, JSON.stringify(changed)); return ready();
  }, fillAndSend: async () => { calls++; } })), { code: 'DISPATCH_CONFLICT' });
  assert.equal(calls, 0);
  assert.equal(read(file).dispatch.state, 'registered');
});

test('helper CLI validates inputs and never returns secrets or parser excerpts', async t => {
  const { dir, file } = fixture(t);
  const input = join(dir, 'input.json');
  writeFileSync(input, JSON.stringify(spec()));
  assert.equal(safe(await dispatchCli(['register', file, input])).state, 'registered');
  writeFileSync(input, JSON.stringify({ prompt, observation: ready() }));
  assert.equal(safe(await dispatchCli(['begin', file, input])).state, 'sending');
  assert.equal(safe(await dispatchCli(['inspect', file])).resendBlocked, true);
  writeFileSync(input, JSON.stringify(sent()));
  assert.equal(safe(await dispatchCli(['confirm', file, input])).state, 'submitted');
  for (const invalid of ['{"prompt":"' + secret, JSON.stringify({ ...ready(), token: secret })]) {
    writeFileSync(input, invalid);
    await assert.rejects(dispatchCli(['prepare', file, input]), error => { safe(error.message); return true; });
  }
  for (const args of [[], ['__proto__', file], ['inspect', file, input], ['register', file, 'relative.json']])
    await assert.rejects(dispatchCli(args), error => { safe(error.message); return true; });
});

test('different Node processes share the same ledger lock', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { dispatchPrompt } from ${JSON.stringify(moduleUrl)};
    await dispatchPrompt(process.argv[1], ${JSON.stringify(prompt)}, {
      observeReady: async () => (${JSON.stringify(ready())}),
      fillAndSend: async () => { process.stdout.write('sending\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); },
      observeSent: async () => (${JSON.stringify(sent())}) });
  `, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('child did not reach dispatch')), 15000);
    child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  try { await assert.rejects(beginDispatch(file, { prompt, observation: ready() }), { code: 'DISPATCH_LOCKED' }); }
  finally { child.stdin.end('continue\n'); }
  assert.equal(await exited, 0, stderr);
  assert.equal(read(file).dispatch.state, 'submitted');
});

test('validators reject unknown nested observation fields and oversized IDs', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  for (const mutate of [o => { o.target.token = secret; }, o => { o.target.tabId = 'a'.repeat(513); },
    o => { o.target.chatUrl += '?token=' + secret; }, o => { o.approvalPending = 'false'; }]) {
    const observation = ready(); mutate(observation);
    await assert.rejects(prepareDispatch(file, observation), { code: 'DISPATCH_OBSERVATION' });
  }
});

// This exercises the real existing client entry point, not an alternate test-only CLI.
test('client dispatch CLI output and malformed-input stderr are bounded and private', async t => {
  const { file, dir } = fixture(t);
  const input = join(dir, 'input.json');
  const client = fileURLToPath(new URL('./client.mjs', import.meta.url));
  const preflight = spawnSync(process.execPath, [client, 'dispatch', 'preflight'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.deepEqual(JSON.parse(preflight.stdout), { runtime: 'node', ready: true });
  assert.equal(preflight.stderr, '');
  writeFileSync(input, JSON.stringify(spec()));
  let run = spawnSync(process.execPath, [client, 'dispatch', 'register', file, input], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(safe(JSON.parse(run.stdout))), summaryKeys);
  assert.equal(run.stderr, '');
  writeFileSync(input, '{"secret":"' + secret);
  run = spawnSync(process.execPath, [client, 'dispatch', 'begin', file, input], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.deepEqual(JSON.parse(run.stderr.trim().replace(/^WebGPT: /, '')), {
    code: 'DISPATCH_INPUT', stage: 'input', reason: 'invalid_input', message: 'invalid private dispatch input',
  });
  safe(run.stderr);
});

test('dangling state fields and invalid optional booleans cannot reset an attempted ledger', async t => {
  const { file } = fixture(t);
  await assert.rejects(registerDispatch(file, { ...spec(), connectorRequired: null }), { code: 'DISPATCH_INPUT' });
  await registerDispatch(file, spec());
  const valid = read(file);
  for (const patch of [{ sendingAt: new Date().toISOString() }, { before: ready() },
    { confirmation: sent() }, { uncertainAt: new Date().toISOString() }, { version: 99 }]) {
    writeFileSync(file, JSON.stringify({ ...valid, dispatch: { ...valid.dispatch, ...patch } }));
    const original = readFileSync(file);
    await assert.rejects(registerDispatch(file, spec()), { code: 'DISPATCH_LEDGER' });
    await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_LEDGER' });
    assert.deepEqual(readFileSync(file), original);
  }
});

test('an injected sending-publication failure prevents any browser side effect', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { dispatchPrompt } from ${JSON.stringify(moduleUrl)};
    const original = fs.renameSync;
    let writes = 0;
    fs.renameSync = (...args) => { if (++writes === 2) throw Error(${JSON.stringify(secret)}); return original(...args); };
    syncBuiltinESMExports();
    try { await dispatchPrompt(process.argv[1], ${JSON.stringify(prompt)}, {
      observeReady: async () => (${JSON.stringify(ready())}),
      fillAndSend: async () => { console.log('BROWSER_CALLED'); },
      observeSent: async () => (${JSON.stringify(sent())}) });
    } catch (error) { console.log(error.code, error.message); }
  `, file], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /DISPATCH_STORAGE/);
  assert.doesNotMatch(run.stdout, /BROWSER_CALLED/);
  safe(run.stdout + run.stderr);
  assert.equal(read(file).dispatch.state, 'prepared');
});

test('an injected confirmation-publication failure leaves sending blocked after a real send callback', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { dispatchPrompt } from ${JSON.stringify(moduleUrl)};
    try { await dispatchPrompt(process.argv[1], ${JSON.stringify(prompt)}, {
      observeReady: async () => (${JSON.stringify(ready())}),
      fillAndSend: async () => { console.log('BROWSER_CALLED_ONCE'); },
      observeSent: async () => {
        fs.renameSync = () => { throw Error(${JSON.stringify(secret)}); }; syncBuiltinESMExports();
        return (${JSON.stringify(sent())});
      } });
    } catch (error) { console.log(error.code, error.message); }
  `, file], { encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /BROWSER_CALLED_ONCE/);
  assert.match(run.stdout, /DISPATCH_STORAGE/);
  safe(run.stdout + run.stderr);
  assert.equal(read(file).dispatch.state, 'sending');
  await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_BLOCKED' });
});

test('forced parent termination preserves intent and a lock that cannot be silently stolen', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  const moduleUrl = new URL('./dispatch.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { dispatchPrompt } from ${JSON.stringify(moduleUrl)};
    await dispatchPrompt(process.argv[1], ${JSON.stringify(prompt)}, {
      observeReady: async () => (${JSON.stringify(ready())}),
      fillAndSend: async () => { process.stdout.write('sending\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); },
      observeSent: async () => (${JSON.stringify(sent())}) });
  `, file], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('child did not reach dispatch')), 15000);
    child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  child.kill('SIGKILL');
  await exited;
  assert.equal(read(file).dispatch.state, 'sending');
  await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_LOCKED' });
  await assert.rejects(recoverDispatch(file), { code: 'DISPATCH_LOCKED' });
  // Simulate explicit operator lock retirement only after the test has proved the owner exited.
  assert.ok(existsSync(file + '.dispatch.lock'));
  rmSync(file + '.dispatch.lock');
  assert.equal((await recoverDispatch(file)).state, 'uncertain');
  await assert.rejects(dispatchPrompt(file, prompt, adapter()), { code: 'DISPATCH_BLOCKED' });
});

test('null or incomplete stored evidence cannot make a submitted record trustworthy', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  await dispatchPrompt(file, prompt, adapter());
  const valid = read(file);
  for (const patch of [{ confirmation: null }, { before: null }, { confirmation: {} }, { before: false }]) {
    writeFileSync(file, JSON.stringify({ ...valid, dispatch: { ...valid.dispatch, ...patch } }));
    await assert.rejects(inspectDispatch(file), { code: 'DISPATCH_LEDGER' });
  }
});

test('xhigh text-only dispatch still verifies mode and body without requiring a connector', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, { ...spec(), mode: 'xhigh', connectorRequired: false });
  const before = { ...ready(), mode: 'xhigh', connectorSelected: false };
  const after = { ...sent(), mode: 'xhigh', connectorSelected: false };
  assert.equal((await dispatchPrompt(file, prompt, adapter({ observeReady: async () => before, observeSent: async () => after }))).state, 'submitted');
});

test('no confirmation before sending and no readiness check with a changed outgoing prompt', async t => {
  const { file } = fixture(t);
  await registerDispatch(file, spec());
  await assert.rejects(confirmDispatch(file, sent()), { code: 'DISPATCH_BLOCKED' });
  let observed = 0;
  await assert.rejects(dispatchPrompt(file, 'different outgoing body', adapter({ observeReady: async () => { observed++; return ready(); } })), { code: 'DISPATCH_INPUT' });
  assert.equal(observed, 0);
  assert.equal(read(file).dispatch.state, 'registered');
});

test('directory aliases share the same canonical task-ledger lock', async t => {
  const { file, dir } = fixture(t);
  const other = mkdtempSync(join(tmpdir(), 'webgpt-dispatch-alias-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const alias = join(other, 'linked-dir');
  symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await registerDispatch(file, spec());
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const work = dispatchPrompt(file, prompt, adapter({ fillAndSend: async () => { entered(); await gate; } }));
  await started;
  try { await assert.rejects(beginDispatch(join(alias, 'ledger.json'), { prompt, observation: ready() }), { code: 'DISPATCH_LOCKED' }); }
  finally { release(); }
  assert.equal((await work).state, 'submitted');
});
