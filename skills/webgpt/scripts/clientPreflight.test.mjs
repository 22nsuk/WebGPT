import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request, waitForTasks } from './client.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const execute = promisify(execFile), cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
const observerUrl = new URL('./test-fixtures/file-read.mjs', import.meta.url).href;
const zero = { stats: 0, lstats: 0, opens: 0, closes: 0, bytes: 0, reads: 0 };
const registration = { id: 'owned', instructions: 'Fixture', inputs: {} };

// Add named-path metadata observations to the existing descriptor reader. The
// same observer runs in API tests and in the real CLI child through its preload.
function observeInputs(t, paths) {
  const entries = Object.entries(paths), metadata = {}, readers = [], mocks = [];
  for (const [name, file] of entries) {
    metadata[name] = { stats: 0, lstats: 0 };
    readers.push([name, observeFileRead(t, file)]);
  }
  for (const [method, count] of [['statSync', 'stats'], ['lstatSync', 'lstats']]) {
    const native = fs[method];
    mocks.push(t.mock.method(fs, method, (file, ...args) => {
      for (const [name, selected] of entries) if (file === selected) metadata[name][count]++;
      return native(file, ...args);
    }));
  }
  syncBuiltinESMExports();
  return {
    get evidence() { return Object.fromEntries(readers.map(([name, reader]) => [name, { ...metadata[name], ...reader.evidence }])); },
    restore() {
      for (const mock of mocks.reverse()) mock.mock.restore();
      for (const [, reader] of readers.slice().reverse()) reader.restore();
      syncBuiltinESMExports();
    },
  };
}

function fixture(t) {
  const base = readFixture(t), data = join(base, 'data'); fs.mkdirSync(data);
  const paths = { input: join(base, '--file'), config: join(base, 'config.json'), key: join(data, 'controller.key') };
  const config = { dataDir: data, mcpPort: 43137, controlPort: 43139 };
  fs.writeFileSync(paths.input, '{invalid-json');
  fs.writeFileSync(paths.config, JSON.stringify(config));
  fs.writeFileSync(paths.key, 'preflight-fixture-key');
  const probe = join(base, 'observe.mjs'), evidence = join(base, 'observed.json');
  fs.writeFileSync(probe, `
    import fs from 'node:fs';
    import { mock } from 'node:test';
    import { syncBuiltinESMExports } from 'node:module';
    import { observeFileRead } from ${JSON.stringify(observerUrl)};
    ${observeInputs.toString()}
    // CLI arguments select the relative filename literally; watch that spelling.
    const observed = observeInputs({ mock }, ${JSON.stringify({ ...paths, input: '--file' })}), requests = [];
    const network = mock.method(globalThis, 'fetch', async (url, options) => {
      const selected = new URL(url);
      requests.push({ path: selected.pathname, ids: selected.searchParams.getAll('id'),
        method: options.method, body: options.body ?? null });
      return { ok: true, json: async () => selected.pathname === '/wait'
        ? { events: [], backupDue: [] } : { ok: true } };
    });
    process.once('exit', () => {
      observed.restore(); network.mock.restore();
      fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ files: observed.evidence, requests }));
    });
  `);
  const env = { ...process.env, WEBGPT_CONFIG: paths.config, WEBGPT_DATA_DIR: data };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  return {
    paths, config,
    async run(args) {
      fs.rmSync(evidence, { force: true });
      let result;
      try {
        result = { code: 0, ...await execute(process.execPath, ['--import', pathToFileURL(probe).href, cli, ...args],
          { cwd: base, env, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }) };
      } catch (error) {
        // A watchdog or launch failure is never an expected CLI rejection.
        assert.equal(error.code, 1, error.stderr || String(error));
        assert.equal(error.signal, null); assert.equal(error.killed, false);
        result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
      return { ...result, observed: JSON.parse(fs.readFileSync(evidence, 'utf8')) };
    },
  };
}

function noReads(files, names = Object.keys(files)) {
  for (const name of names) assert.deepEqual(files[name], zero, name + ' must not be inspected');
}
function refused(result, message) {
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WebGPT: ' + message + '\n');
  assert.deepEqual(result.observed.requests, []);
}
function readOnce(evidence, bytes) {
  assert.ok(evidence.stats + evidence.lstats > 0, 'metadata observer must see the real read');
  assert.equal(evidence.opens, 1); assert.equal(evidence.closes, 1);
  assert.ok(evidence.reads > 0); assert.equal(evidence.bytes, bytes);
}
async function withDefaultConfig(f, run) {
  const saved = { WEBGPT_CONFIG: process.env.WEBGPT_CONFIG, WEBGPT_DATA_DIR: process.env.WEBGPT_DATA_DIR };
  process.env.WEBGPT_CONFIG = f.paths.config; process.env.WEBGPT_DATA_DIR = f.config.dataDir;
  try { return await run(); }
  finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test('general CLI action and arity errors precede input, configuration, key and controller I/O', async t => {
  const f = fixture(t);
  const cases = [
    ...[[], ['stauts'], ['stauts', '--file']].map(args => [args, 'unknown controller action']),
    ...['status', 'tasks', 'ready', 'shutdown'].map(action => [[action, '--file'], 'unexpected controller arguments']),
    ...[[], [''], ['--file', 'extra']].map(args => [['register', ...args], 'usage: client.mjs register <json-file>']),
  ];
  for (const [args, message] of cases) {
    const result = await f.run(args);
    refused(result, message); noReads(result.observed.files);
  }
});

test('general CLI static task-ID errors precede configuration and key inspection', async t => {
  const f = fixture(t);
  for (const args of [
    ['wait', 'owned', 'bad/id'], ['wait', '--'], ['wait', '--', './payload'],
    ['reconcile', 'bad/id'], ['collect', 'bad/id'], ['collect', '--resume', '--', 'bad/id'],
  ]) {
    const result = await f.run(args);
    refused(result, 'nonempty task IDs required'); noReads(result.observed.files);
  }
});

test('wait validates file-selected IDs after reading that file but before configuration', async t => {
  const f = fixture(t), bytes = JSON.stringify({ ids: ['owned', 'bad/id'] });
  fs.writeFileSync(f.paths.input, bytes);
  const result = await f.run(['wait', '--file', '--file']);
  refused(result, 'nonempty task IDs required');
  readOnce(result.observed.files.input, Buffer.byteLength(bytes));
  noReads(result.observed.files, ['config', 'key']);
  assert.equal(fs.readFileSync(f.paths.input, 'utf8'), bytes);
});

test('valid ordinary CLI commands retain their wire shape and positively exercise I/O observers', async t => {
  const f = fixture(t), bytes = JSON.stringify(registration);
  fs.writeFileSync(f.paths.input, bytes);
  for (const action of ['status', 'tasks', 'wait', 'register']) {
    const result = await f.run(action === 'register' ? [action, '--file'] : [action]);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), action === 'wait' ? { events: [], backupDue: [] } : { ok: true });
    assert.deepEqual(result.observed.requests, [{ path: '/' + action, ids: [],
      method: action === 'register' ? 'POST' : 'GET', body: action === 'register' ? bytes : null }]);
    readOnce(result.observed.files.config, Buffer.byteLength(JSON.stringify(f.config)));
    readOnce(result.observed.files.key, Buffer.byteLength('preflight-fixture-key'));
    assert.ok(result.observed.files.config.stats > 0); assert.ok(result.observed.files.key.lstats > 0);
    if (action === 'register') readOnce(result.observed.files.input, Buffer.byteLength(bytes));
    else noReads(result.observed.files, ['input']);
  }
});

test('request and scoped-wait API preflight rejects before resolving omitted configuration', async t => {
  const f = fixture(t), observed = observeInputs(t, f.paths);
  const network = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected controller request'); });
  const reason = Error('preflight cancellation'), signal = AbortSignal.abort(reason);
  try {
    await withDefaultConfig(f, async () => {
      const cases = [
        [() => request('stauts'), /unknown controller action/],
        [() => request('status', { ids: ['owned'] }), /invalid controller payload/],
        [() => request('register', []), /invalid controller payload/],
        [() => request('wait', { ids: [] }), /nonempty task IDs required/],
        [() => request('reconcile', { ids: ['bad/id'] }), /nonempty task IDs required/],
        [() => request('status', undefined, undefined, { timeoutMs: 0 }), /invalid controller timeout/],
        [() => request('status', undefined, undefined, { signal }), error => error === reason],
        [() => waitForTasks([]), /nonempty task IDs required/],
        [() => waitForTasks(['owned'], undefined, { retryDelays: [-1] }), /invalid bounded wait retry policy/],
      ];
      for (const [run, expected] of cases) await assert.rejects(run(), expected);
    });
  } finally { observed.restore(); }
  noReads(observed.evidence); assert.equal(network.mock.callCount(), 0);
});

test('default wait configuration is captured once across renewal and transport retry', async t => {
  const f = fixture(t), replacement = join(f.config.dataDir, 'replacement-config.json'), urls = [];
  fs.writeFileSync(replacement, JSON.stringify({ ...f.config, controlPort: 43140 }));
  const observed = observeInputs(t, f.paths);
  const done = { events: [{ id: 'owned', status: 'completed' }], backupDue: [], settled: true };
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    if (urls.length === 1) {
      process.env.WEBGPT_CONFIG = replacement;
      throw TypeError('fixture transport failure', { cause: { code: 'ECONNRESET' } });
    }
    return { ok: true, json: async () => urls.length === 2 ? { events: [], backupDue: [], settled: false } : done };
  });
  try {
    await withDefaultConfig(f, async () => {
      assert.deepEqual(await waitForTasks(['owned'], undefined, { retryDelays: [0] }), done);
    });
  } finally { observed.restore(); }
  assert.deepEqual(urls, Array(3).fill('http://127.0.0.1:43139/wait?id=owned'));
  readOnce(observed.evidence.config, Buffer.byteLength(JSON.stringify(f.config)));
  assert.equal(observed.evidence.key.opens, 3); assert.equal(observed.evidence.key.closes, 3);
  noReads(observed.evidence, ['input']);
});
