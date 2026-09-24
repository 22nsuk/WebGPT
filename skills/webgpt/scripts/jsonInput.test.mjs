// User-authored local JSON fixtures only; no installed runtime or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { configuration, configurationFile, request } from './client.mjs';
import { runService, requestServiceStop } from './service.mjs';
import { start } from './worker.mjs';
import { observeChild, untilFixture } from './test-fixtures/worker-process.mjs';

const execute = promisify(execFile);
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const privateText = 'PRIVATE_JSON_INPUT_FIXTURE';
const jsonBytes = (value, prefix = Buffer.alloc(0)) => Buffer.concat([prefix, Buffer.from(JSON.stringify(value))]);
function invalidBytes(value, bytes = Buffer.from([0xff])) {
  const [before, after] = JSON.stringify(value).split('INVALID_BYTES');
  assert.notEqual(after, undefined);
  return Buffer.concat([Buffer.from(before), bytes, Buffer.from(after)]);
}
function fixture(t, beforeCleanup = () => {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt json 한글 ')));
  const file = join(base, 'config.json'), dir = join(base, 'runtime');
  const env = { ...process.env, WEBGPT_CONFIG: file }; delete env.WEBGPT_DATA_DIR;
  const config = { dataDir: dir, mcpPort: 12340, controlPort: 12341, publicMcp: false };
  t.after(async () => { await beforeCleanup(); fs.rmSync(base, { recursive: true, force: true }); });
  fs.writeFileSync(file, jsonBytes(config));
  return { base, file, dir, env, config };
}
function exited() {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0, null); });
  return child;
}

for (const marked of [false, true]) test(`UTF-8 configuration ${marked ? 'with' : 'without'} BOM preserves exact Unicode and overrides`, t => {
  const f = fixture(t), saved = { ...f.config, dataDir: join(f.base, '한글 🧪 \ufeff �') };
  fs.writeFileSync(f.file, jsonBytes(saved, marked ? bom : undefined));
  const before = fs.readFileSync(f.file);
  assert.deepEqual(configuration(f.env), saved);
  assert.equal(configuration({ ...f.env, WEBGPT_DATA_DIR: f.dir }).dataDir, f.dir);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(fs.existsSync(saved.dataDir), false);
});

for (const [label, bytes] of [
  ['invalid lead', [0xff]], ['overlong', [0xc0, 0xaf]], ['truncated sequence', [0xe2, 0x82]],
  ['encoded surrogate', [0xed, 0xa0, 0x80]], ['legacy non-UTF8', [0xc7, 0xd1, 0xb1, 0xdb]],
]) test(`configuration rejects ${label} bytes instead of substituting a runtime pathname`, t => {
  const f = fixture(t), original = invalidBytes({ ...f.config, dataDir: join(f.base, 'INVALID_BYTES') }, Buffer.from(bytes));
  fs.writeFileSync(f.file, original);
  assert.throws(() => configuration(f.env), /JSON|UTF-8/);
  // A data-directory override must not hide a corrupt configuration file.
  assert.throws(() => configuration({ ...f.env, WEBGPT_DATA_DIR: f.dir }), /JSON|UTF-8/);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.deepEqual(fs.readdirSync(f.base), ['config.json']);
});

for (const [label, bytes] of [
  ['UTF-16LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"dataDir":"unused"}', 'utf16le')])],
  ['BOM only', bom], ['repeated BOM', Buffer.concat([bom, bom, Buffer.from('{}')])],
  ['invalid JSON', Buffer.from('{"' + privateText + '": invalid}')],
]) test(`invalid ${label} input stays rejected without echoing its contents`, t => {
  const f = fixture(t); fs.writeFileSync(f.file, bytes);
  assert.throws(() => configuration(f.env), error => {
    assert.match(error.message, /JSON|UTF-8/); assert.ok(!error.message.includes(privateText)); return true;
  });
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  assert.equal(fs.existsSync(f.dir), false);
});

for (const source of ['saved dataDir', 'environment dataDir', 'configuration path'])
  test(`unpaired JSON/path surrogates cannot select a replacement-character ${source}`, t => {
    const f = fixture(t), malformed = join(f.base, 'bad-\ud800');
    if (source === 'saved dataDir') {
      fs.writeFileSync(f.file, jsonBytes({ ...f.config, dataDir: malformed }));
      assert.throws(() => configuration(f.env), /dataDir/);
    } else if (source === 'environment dataDir') {
      assert.throws(() => configuration({ ...f.env, WEBGPT_DATA_DIR: malformed }), /dataDir/);
    } else assert.throws(() => configurationFile({ WEBGPT_CONFIG: malformed }), /WEBGPT_CONFIG/);
    assert.equal(fs.existsSync(f.dir), false);
  });

test('an explicit configuration disappearing before the read never becomes implicit defaults', t => {
  const f = fixture(t), read = fs.readFileSync, exists = fs.existsSync;
  let probes = 0;
  t.mock.method(fs, 'existsSync', path => path === f.file ? ++probes === 1 : exists(path));
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === f.file) throw Object.assign(Error('fixture missing config'), { code: 'ENOENT' });
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => configuration(f.env), { message: 'WEBGPT_CONFIG file does not exist' }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.dir), false);
});

for (const code of ['ENOENT', 'EACCES', 'EIO']) test(`implicit configuration handles ${code} without hiding nonabsence errors`, t => {
  const f = fixture(t), env = { WEBGPT_DATA_DIR: f.dir }, implicit = configurationFile(env);
  const read = fs.readFileSync, exists = fs.existsSync;
  const failure = Object.assign(Error('fixture local read failure'), { code });
  // Never read or write the account-profile config; model its filesystem outcome.
  t.mock.method(fs, 'existsSync', path => path === implicit ? false : exists(path));
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === implicit) throw failure;
    return read(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    if (code === 'ENOENT') assert.deepEqual(configuration(env), {
      dataDir: f.dir, mcpPort: 43137, controlPort: 43139, publicMcp: false,
    });
    else assert.throws(() => configuration(env), error => error === failure);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.dir), false);
});

test('a service configuration is decoded and checked for explicit dataDir from one read', async t => {
  const f = fixture(t), read = fs.readFileSync, mkdir = fs.mkdirSync;
  let reads = 0, launched = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === f.file && ++reads > 1) return args[0] === 'utf8' ? '{}' : Buffer.from('{}');
    return read(file, ...args);
  });
  // Baseline's second read would select the account-profile default. Never create it.
  t.mock.method(fs, 'mkdirSync', (path, ...args) => {
    assert.ok(path === f.dir || path.startsWith(f.dir + sep), 'must not create a fallback runtime');
    return mkdir(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await runService(f.env, { record: () => {}, spawnWorker: (_exe, _args, options) => {
      launched++; assert.equal(options.cwd, f.dir); return exited();
    } }), 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(reads, 1); assert.equal(launched, 1);
  assert.equal(fs.existsSync(join(f.dir, 'service.lock')), false);
});

for (const marked of [false, true]) test(`service ${marked ? 'BOM' : 'plain'} configuration keeps explicit-directory and stop contracts`, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, jsonBytes(f.config, marked ? bom : undefined));
  assert.equal(await runService(f.env, { record: () => {}, spawnWorker: () => {
    assert.deepEqual(requestServiceStop(f.env), { accepted: true }); return exited();
  } }), 0);
  assert.equal(fs.existsSync(join(f.dir, 'service.lock')), false);
  fs.writeFileSync(f.file, jsonBytes({}, marked ? bom : undefined));
  await assert.rejects(runService(f.env, { spawnWorker: () => assert.fail('missing explicit directory') }), { code: 'CONFIG_INVALID' });
});

test('invalid service config fails before creating a runtime or spawning a child', async t => {
  const f = fixture(t), bytes = invalidBytes({ dataDir: join(f.base, 'INVALID_BYTES') });
  fs.writeFileSync(f.file, bytes);
  let launched = false;
  await assert.rejects(runService(f.env, { record: () => {}, spawnWorker: () => { launched = true; return exited(); } }), { code: 'CONFIG_INVALID' });
  assert.equal(launched, false); assert.deepEqual(fs.readdirSync(f.base), ['config.json']);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
});

test('real worker CLI refuses invalid config bytes rather than starting in a different directory', { timeout: 15000 }, async t => {
  const f = fixture(t); fs.writeFileSync(f.file, invalidBytes({ ...f.config, dataDir: join(f.base, 'INVALID_BYTES') }));
  const preload = new URL('./test-fixtures/worker-process.mjs?ephemeral', import.meta.url).href;
  const observed = observeChild(spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url))], {
    env: { ...f.env, NODE_OPTIONS: '--import=' + preload }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  }));
  const deadline = setTimeout(() => observed.child.kill('SIGKILL'), 10000);
  let outcome;
  try {
    await untilFixture(() => observed.listening || observed.child.exitCode !== null, { timeoutMs: 8000, diagnostic: observed.diagnostic });
    // On the baseline, stop only this wrongly started disposable child before asserting.
    if (observed.listening && observed.child.connected) observed.child.send({ type: 'shutdown' });
    outcome = await observed.exit;
  } finally {
    if (observed.child.exitCode === null && observed.child.signalCode === null) observed.child.kill('SIGKILL');
    await observed.exit; clearTimeout(deadline);
  }
  assert.deepEqual(outcome, [78, null], observed.diagnostic());
  assert.equal(observed.listening, null);
  assert.deepEqual(fs.readdirSync(f.base), ['config.json']);
});

async function controllerFixture(t) {
  let worker;
  const f = fixture(t, () => worker?.close());
  worker = await start({ dir: f.dir, port: 0, controlPort: 0, configFile: f.file, waitMs: 20 });
  f.config.controlPort = worker.controlPort; f.config.mcpPort = worker.mcpPort;
  fs.writeFileSync(f.file, jsonBytes(f.config));
  const admin = (action, payload) => request(action, payload, f.config);
  const register = id => admin('register', { id, instructions: 'Fixture', inputs: {} });
  const complete = async token => (await (await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'submit_result', arguments: { token, status: 'completed', summary: 'done', result: 'fixture result' } } }),
  })).json()).result;
  const cli = args => execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), ...args],
    { env: f.env, cwd: f.base, timeout: 10000, windowsHide: true });
  return { ...f, admin, register, complete, cli };
}

for (const marked of [false, true]) test(`registration CLI preserves Korean/emoji/CRLF and interior BOM from ${marked ? 'BOM' : 'plain'} JSON`, async t => {
  const f = await controllerFixture(t), file = join(f.base, 'register.json');
  const spec = { id: 'registered', instructions: '\ufeff한글 🧪\r\n' + privateText, inputs: { source: 'literal � and \ufeff' } };
  const original = jsonBytes(spec, marked ? bom : undefined); fs.writeFileSync(file, original);
  const result = JSON.parse((await f.cli(['register', file])).stdout);
  assert.equal(result.id, spec.id);
  const stored = JSON.parse(fs.readFileSync(join(f.dir, 'state.json')))[0];
  assert.equal(stored.instructions, spec.instructions); assert.deepEqual(stored.inputs, spec.inputs);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('invalid registration payload bytes fail locally without registering replacement text', async t => {
  const f = await controllerFixture(t), file = join(f.base, 'register.json');
  const bytes = invalidBytes({ id: 'invalid', instructions: 'INVALID_BYTES', inputs: {} });
  fs.writeFileSync(file, bytes);
  await assert.rejects(f.cli(['register', file]), error => error.code === 1 && /JSON|UTF-8/.test(error.stderr));
  assert.deepEqual(await f.admin('tasks'), { running: 0, uncollected: 0, tasks: [] });
  assert.equal(fs.existsSync(join(f.dir, 'state.json')), false);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

for (const action of ['wait', 'checked', 'cancel', 'ack']) for (const marked of [true, false]) {
  test(`${action} file payload ${marked ? 'accepts UTF-8 BOM' : 'rejects invalid UTF-8 before controller effects'}`, async t => {
    const f = await controllerFixture(t), file = join(f.base, 'action.json');
    const { token } = await f.register('owned');
    if (['ack', 'wait'].includes(action)) assert.equal((await f.complete(token)).isError, false);
    const payload = action === 'wait' ? { ids: ['owned'], note: 'INVALID_BYTES' } : { id: 'owned', note: 'INVALID_BYTES' };
    const bytes = marked ? jsonBytes(payload, bom) : invalidBytes(payload);
    fs.writeFileSync(file, bytes);
    const state = join(f.dir, 'state.json'), before = fs.readFileSync(state);
    const args = [action, ...(action === 'checked' ? [] : ['--file']), file];
    if (marked) {
      const response = JSON.parse((await f.cli(args)).stdout);
      if (action === 'wait') assert.equal(response.events[0].id, 'owned');
      else assert.equal(response.ok, true);
    } else {
      await assert.rejects(f.cli(args), error => error.code === 1 && /JSON|UTF-8/.test(error.stderr));
      assert.deepEqual(fs.readFileSync(state), before);
    }
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
}
