// Exercise default-configuration ordering without touching an installed runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { diagnoseTask } from './diagnose.mjs';
import { checkVerification, prepareVerification } from './verification.mjs';
import { request } from './client.mjs';
import { start } from './worker.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const execute = promisify(execFile);
const invalidVerification = 'invalid verification input; preserve the private run directory';
const verificationStderr = 'WebGPT verification: unavailable or invalid input; inspect private evidence.\n';
const configKinds = ['missing', 'json', 'utf8', 'valid'];

// Observe attempted metadata reads as well as opens, including missing paths.
// The CLI preload filters out module loading outside its disposable fixture.
function observeAccess(t, base) {
  const calls = [], mocks = [];
  for (const method of ['statSync', 'lstatSync', 'openSync', 'readFileSync', 'readdirSync']) {
    const native = fs[method];
    mocks.push(t.mock.method(fs, method, (path, ...args) => {
      if (typeof path === 'string' && (resolve(path) === base || resolve(path).startsWith(base + sep)))
        calls.push({ method, path });
      return native(path, ...args);
    }));
  }
  syncBuiltinESMExports();
  return { calls, restore() {
    for (const mock of mocks.reverse()) mock.mock.restore();
    syncBuiltinESMExports();
  } };
}

function fixture(t, kind = 'valid') {
  const base = readFixture(t), dataDir = join(base, 'runtime'), run = join(base, 'private-run');
  const file = join(base, 'private-config.json'), config = { dataDir, mcpPort: 43137, controlPort: 43139 };
  if (kind !== 'missing') fs.writeFileSync(file, kind === 'json' ? '{PRIVATE_CONFIG_SECRET'
    : kind === 'utf8' ? Buffer.from([0xff]) : JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dataDir };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  return { base, file, run, config, env };
}

async function withConfig(f, run) {
  const saved = { WEBGPT_CONFIG: process.env.WEBGPT_CONFIG, WEBGPT_DATA_DIR: process.env.WEBGPT_DATA_DIR };
  process.env.WEBGPT_CONFIG = f.file; process.env.WEBGPT_DATA_DIR = f.config.dataDir;
  try { return await run(); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function noRuntime(f) {
  assert.equal(fs.existsSync(f.config.dataDir), false, 'no runtime, state or key may be created');
  assert.equal(fs.existsSync(f.run), false, 'no verification run may be created');
}

for (const entry of ['diagnose', 'verification']) for (const kind of configKinds)
  test(`${entry} API input errors precede ${kind} default configuration and all evidence I/O`, async t => {
  const f = fixture(t, kind), observed = observeAccess(t, f.base);
  const network = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected controller request'); });
  try {
    await withConfig(f, async () => {
      // Omission and explicit undefined select defaults; other values must not.
      for (const configArgs of [[], [undefined], [f.config], [null]]) {
        if (entry === 'diagnose') {
          for (const id of [undefined, null, 42, {}, '', 'bad/id', 'x'.repeat(81), 'NUL', '\ud800'])
            assert.throws(() => diagnoseTask(id, ...configArgs), { message: 'invalid task ID' });
        } else {
          for (const path of [undefined, null, 42, {}, [], '', 'relative-run', join(f.base, 'run-\ud800')])
            await assert.rejects(checkVerification(path, ...configArgs), { message: invalidVerification });
        }
      }
    });
  } finally { observed.restore(); }
  assert.deepEqual(observed.calls, []); assert.equal(network.mock.callCount(), 0); noRuntime(f);
});

for (const kind of configKinds.filter(kind => kind !== 'valid'))
  test(`valid diagnostic API inputs retain ${kind} configuration failures before state or run inspection`, async t => {
    const f = fixture(t, kind), observed = observeAccess(t, f.base);
    const network = t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected controller request'); });
    const expected = { message: kind === 'missing' ? 'WEBGPT_CONFIG file does not exist' : 'invalid JSON or UTF-8 input file' };
    try {
      await withConfig(f, async () => {
        assert.throws(() => diagnoseTask('owned'), expected);
        await assert.rejects(checkVerification(f.run), expected);
      });
    } finally { observed.restore(); }
    assert.ok(observed.calls.length > 0, 'the observer sees actual configuration I/O');
    assert.ok(observed.calls.every(call => call.path === f.file), 'run and state must still follow configuration');
    assert.equal(network.mock.callCount(), 0); noRuntime(f);
  });

for (const entry of ['diagnose', 'verification'])
  test(`${entry} resolves omitted configuration once and preserves real completed-task evidence`, async t => {
    const f = fixture(t), prepared = prepareVerification('text', f.run, 'pro');
    const worker = await start({ dir: f.config.dataDir, port: 0, controlPort: 0, audit: false });
    try {
      Object.assign(f.config, { mcpPort: worker.mcpPort, controlPort: worker.controlPort });
      fs.writeFileSync(f.file, JSON.stringify(f.config));
      const task = await request('register', JSON.parse(fs.readFileSync(join(f.run, 'request.json'), 'utf8')), f.config);
      assert.equal((await callTool(worker, 'submit_result', { token: task.token, status: 'completed',
        summary: 'Fixture', result: JSON.stringify({ total: 34, units: 4 }) })).isError, false);
      const stateFile = join(f.config.dataDir, 'state.json'), before = fs.readFileSync(stateFile);
      const call = (...args) => entry === 'diagnose' ? diagnoseTask(prepared.taskId, ...args) : checkVerification(f.run, ...args);
      const expected = await call(f.config);
      if (entry === 'diagnose') {
        assert.equal(expected.task.status, 'completed'); assert.equal(expected.task.integrity, 'verified');
      } else assert.equal(expected.localVerdict, 'PASS');
      assert.equal(expected.browserChecked, false);
      for (const configArgs of [[], [undefined], [f.config]]) {
        const observed = observeAccess(t, f.base), configRead = observeFileRead(t, f.file);
        try {
          await withConfig(f, async () => {
            // An explicit configuration must work even when the default is unusable.
            if (configArgs[0] === f.config) process.env.WEBGPT_CONFIG = join(f.base, 'missing-config.json');
            assert.deepEqual(await call(...configArgs), expected);
          });
        } finally { configRead.restore(); observed.restore(); }
        const defaults = configArgs[0] === undefined;
        assert.equal(configRead.evidence.opens, defaults ? 1 : 0);
        assert.equal(configRead.evidence.closes, defaults ? 1 : 0);
        assert.equal(configRead.evidence.bytes, defaults ? Buffer.byteLength(JSON.stringify(f.config)) : 0);
        const firstEvidence = observed.calls.findIndex(({ path }) => path !== f.file);
        assert.ok(firstEvidence >= 0, 'state/run observers see the successful flow');
        if (defaults) {
          assert.ok(firstEvidence > 0, 'configuration must precede state/run inspection');
          assert.ok(observed.calls.slice(firstEvidence).every(({ path }) => path !== f.file), 'configuration is not reread');
        }
        assert.deepEqual(fs.readFileSync(stateFile), before, 'diagnosis cannot collect or rewrite the task');
      }
    } finally { await worker.close(); }
  });

for (const entry of ['diagnose', 'verification']) for (const kind of configKinds)
  test(`real ${entry} CLI retains fixed private error output with ${kind} configuration`, async t => {
  const f = fixture(t, kind), probe = join(f.base, 'observe.mjs'), evidence = join(f.base, 'observed.json');
  fs.writeFileSync(probe, `
    import fs from 'node:fs';
    import { resolve, sep } from 'node:path';
    import { mock } from 'node:test';
    import { syncBuiltinESMExports } from 'node:module';
    ${observeAccess.toString()}
    const observed = observeAccess({ mock }, ${JSON.stringify(f.base)});
    const network = mock.method(globalThis, 'fetch', () => { throw Error('PRIVATE_NETWORK_ERROR'); });
    process.once('exit', () => {
      observed.restore();
      fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ files: observed.calls, requests: network.mock.callCount() }));
    });
  `);
  const cases = entry === 'diagnose' ? [
    [['bad/PRIVATE_TASK'], 'WebGPT diagnose: invalid task ID\n', true],
    [['owned'], 'WebGPT diagnose: ' + (kind === 'valid' ? 'task state unavailable' : 'diagnosis unavailable') + '\n', false],
  ] : [
    [['check', 'relative-PRIVATE_RUN'], verificationStderr, true],
    [['check', f.run], verificationStderr, false],
  ];
  for (const [args, stderr, invalid] of cases) {
    fs.rmSync(evidence, { force: true });
    const cli = fileURLToPath(new URL(`./${entry}.mjs`, import.meta.url));
    await assert.rejects(execute(process.execPath, ['--import', pathToFileURL(probe).href, cli, ...args], {
      cwd: f.base, env: f.env, windowsHide: true, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536,
    }), error => {
      assert.equal(error.code, 1); assert.equal(error.signal, null); assert.equal(error.killed, false);
      assert.equal(error.stdout, ''); assert.equal(error.stderr, stderr); return true;
    });
    const observed = JSON.parse(fs.readFileSync(evidence, 'utf8'));
    assert.equal(observed.requests, 0);
    if (invalid) assert.deepEqual(observed.files, []);
    else {
      assert.equal(observed.files[0]?.path, f.file, 'valid CLI input still resolves configuration first');
      if (kind !== 'valid') assert.ok(observed.files.every(call => call.path === f.file));
    }
    noRuntime(f);
  }
});
