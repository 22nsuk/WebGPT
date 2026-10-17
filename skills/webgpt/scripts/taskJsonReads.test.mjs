// Exercise the real client entry with disposable inputs and a loopback worker.
// JSON encoding details remain covered by jsonInput.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Server } from 'node:http';
import { start } from './worker.mjs';
import { readUnboundedFile } from './bounded-read.mjs';
import { readFixture } from './test-fixtures/file-read.mjs';

const execute = promisify(execFile);
const client = fileURLToPath(new URL('./client.mjs', import.meta.url));
const observerUrl = new URL('./test-fixtures/file-read.mjs', import.meta.url).href;
const payload = '{"id":"owned","instructions":"Fixture","inputs":{}}';
const invalid = 'WebGPT: JSON input must be a regular file with unchanged identity\n';
const routes = [
  { name: 'register', args: file => ['register', file] },
  { name: 'wait --file', args: file => ['wait', '--file', file] },
  ...['ack', 'checked', 'cancel'].map(name => ({ name: name + ' --file', args: file => [name, '--file', file] })),
];

async function fixture(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-task-json-')));
  const dir = join(base, 'runtime'), configFile = join(base, 'config.json'), requests = [];
  let worker, observer;
  t.after(async () => {
    observer?.mock.restore();
    await worker?.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  worker = await start({ dir, port: 0, controlPort: 0, configFile, waitMs: 20, closeGraceMs: 50 });
  const config = { dataDir: dir, mcpPort: worker.mcpPort, controlPort: worker.controlPort };
  fs.writeFileSync(configFile, JSON.stringify(config));
  const emit = Server.prototype.emit;
  observer = t.mock.method(Server.prototype, 'emit', function(event, ...args) {
    const result = Reflect.apply(emit, this, [event, ...args]);
    if (event === 'request' && this.address()?.port === worker.controlPort)
      requests.push({ method: args[0].method, url: args[0].url });
    return result;
  });
  const env = { ...process.env, WEBGPT_CONFIG: configFile, WEBGPT_DATA_DIR: dir };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  return {
    base, dir, requests,
    async run(args, probe) {
      let result;
      try {
        result = { code: 0, ...await execute(process.execPath,
          [...(probe ? ['--import', pathToFileURL(probe).href] : []), client, ...args],
          { cwd: base, env, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }) };
      } catch (error) {
        // A watchdog or launch failure is a failed test, never an expected refusal.
        assert.equal(error.code, 1, error.stderr || String(error));
        assert.equal(error.signal, null); assert.equal(error.killed, false);
        result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
      return result;
    },
    untouched() {
      assert.deepEqual(requests, [], 'invalid local input must not reach the controller');
      assert.equal(fs.existsSync(join(dir, 'state.json')), false, 'invalid input must not register or retire work');
    },
  };
}

function fifo(file) { execFileSync('mkfifo', [file], { timeout: 5000 }); }
function sameMetadata(before, after) {
  for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs']) assert.equal(after[key], before[key], key);
}
function refused(result, diagnostic = invalid) {
  assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, diagnostic);
}

// A preload injects only native I/O faults. The existing observer tracks reads and
// descriptor ownership; no client parsing or command implementation is copied.
function inputProbe(f, file, mode) {
  const probe = join(f.base, 'input-probe.mjs'), evidence = join(f.base, 'input-evidence.json');
  fs.writeFileSync(probe, `
    import fs from 'node:fs';
    import { mock } from 'node:test';
    import { execFileSync } from 'node:child_process';
    import { observeFileRead } from ${JSON.stringify(observerUrl)};
    const file = ${JSON.stringify(file)}, mode = ${JSON.stringify(mode)};
    let injected = false;
    const observed = observeFileRead({ mock }, file, {
      beforeOpen() {
        if (injected) return;
        if (mode === 'ENOENT') {
          injected = true;
          throw Object.assign(Error('fixture late ENOENT'), { code: 'ENOENT' });
        }
        if (mode === 'fifo' || mode === 'replacement') {
          injected = true;
          fs.renameSync(file, file + '.original');
          if (mode === 'fifo') execFileSync('mkfifo', [file], { timeout: 5000 });
          else fs.copyFileSync(file + '.original', file);
        }
      },
      beforeRead() {
        if (mode === 'EIO') {
          injected = true;
          throw Object.assign(Error('fixture read EIO'), { code: 'EIO' });
        }
      },
    });
    process.once('exit', () => {
      observed.restore();
      fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ ...observed.evidence, injected }));
    });
  `);
  return { probe, read: () => JSON.parse(fs.readFileSync(evidence, 'utf8')) };
}

for (const route of routes) test(`${route.name} refuses a writerless JSON FIFO before its watchdog`,
  { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t), file = join(f.base, 'input.json'); fifo(file);
    const before = fs.lstatSync(file, { bigint: true });
    refused(await f.run(route.args(file)));
    f.untouched(); assert.equal(fs.lstatSync(file).isFIFO(), true);
    sameMetadata(before, fs.lstatSync(file, { bigint: true }));
  });

// The two parser branches cover the race; every other routing branch is exercised
// with a known FIFO above instead of multiplying all routes by every fault.
for (const route of routes.slice(0, 2)) test(`${route.name} rejects JSON replaced with a FIFO at open and closes it`,
  { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t), file = join(f.base, 'input.json'); fs.writeFileSync(file, payload);
    const observed = inputProbe(f, file, 'fifo');
    refused(await f.run(route.args(file), observed.probe));
    assert.deepEqual(observed.read(), { opens: 1, closes: 1, bytes: 0, reads: 0, injected: true });
    assert.equal(fs.lstatSync(file).isFIFO(), true);
    assert.equal(fs.readFileSync(file + '.original', 'utf8'), payload); f.untouched();
  });

test('JSON descriptor identity is checked before decoding even when replacement bytes match', async t => {
  const f = await fixture(t), file = join(f.base, 'input.json'); fs.writeFileSync(file, payload);
  const observed = inputProbe(f, file, 'replacement');
  refused(await f.run(['register', file], observed.probe));
  assert.deepEqual(observed.read(), { opens: 1, closes: 1, bytes: 0, reads: 0, injected: true });
  for (const path of [file, file + '.original']) assert.equal(fs.readFileSync(path, 'utf8'), payload);
  f.untouched();
});

for (const mode of ['ENOENT', 'EIO']) test(`JSON ${mode === 'ENOENT' ? 'late open disappearance' : 'read failure'} preserves native failure and descriptor ownership`, async t => {
  const f = await fixture(t), file = join(f.base, 'input.json'); fs.writeFileSync(file, payload);
  const observed = inputProbe(f, file, mode);
  refused(await f.run(['register', file], observed.probe),
    `WebGPT: fixture ${mode === 'ENOENT' ? 'late ENOENT' : 'read EIO'}\n`);
  const descriptors = mode === 'EIO' ? 1 : 0;
  assert.deepEqual(observed.read(), { opens: descriptors, closes: descriptors, bytes: 0, reads: 0, injected: true });
  assert.equal(fs.readFileSync(file, 'utf8'), payload); f.untouched();
});

test('JSON initial absence and directories fail locally without creating or changing input files', async t => {
  const f = await fixture(t), file = join(f.base, 'input.json');
  refused(await f.run(['register', file]), 'WebGPT: JSON input file does not exist\n');
  assert.equal(fs.existsSync(file), false);
  fs.mkdirSync(file);
  const before = fs.lstatSync(file, { bigint: true });
  refused(await f.run(['wait', '--file', file]));
  assert.deepEqual(fs.readdirSync(file), []); sameMetadata(before, fs.lstatSync(file, { bigint: true }));
  f.untouched();
});

test('large escaped JSON with a BOM remains a valid registration beyond the HTTP raw-byte allowance', async t => {
  const f = await fixture(t), file = join(f.base, 'input.json');
  const text = '\ufeff{"id":"large","instructions":"Fixture","inputs":{"sample":"' + '\\u0061'.repeat(600000) + '"}}';
  fs.writeFileSync(file, text);
  assert.ok(Buffer.byteLength(text) > 2 * 1024 * 1024);
  const result = await f.run(['register', file]);
  assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout).id, 'large');
  const stored = JSON.parse(fs.readFileSync(join(f.dir, 'state.json'), 'utf8'));
  assert.equal(stored.length, 1); assert.equal(stored[0].inputs.sample, 'a'.repeat(600000));
  assert.deepEqual(f.requests, [{ method: 'POST', url: '/register' }]);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

for (const kind of ['hardlink', 'symlink']) test(`JSON ${kind} inputs remain supported while unbounded private reads stay strict`, async t => {
  const f = await fixture(t), file = join(f.base, 'input.json'), source = join(f.base, 'source.json');
  fs.writeFileSync(source, payload);
  try {
    if (kind === 'hardlink') fs.linkSync(source, file); else fs.symlinkSync(source, file, 'file');
  } catch (error) {
    if (kind === 'symlink' && process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code))
      return t.skip('native file symlink creation is unavailable');
    throw error;
  }
  const before = fs.lstatSync(file, { bigint: true }), failure = Error('strict fixture rejection');
  assert.throws(() => readUnboundedFile(file, () => failure), error => error === failure);
  const result = await f.run(['register', file]);
  assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(JSON.parse(result.stdout).id, 'owned');
  assert.deepEqual(f.requests, [{ method: 'POST', url: '/register' }]);
  for (const path of [source, file]) assert.equal(fs.readFileSync(path, 'utf8'), payload);
  sameMetadata(before, fs.lstatSync(file, { bigint: true }));
});

test('unbounded link compatibility requires an explicit boolean policy', t => {
  const file = join(readFixture(t), 'missing');
  for (const allowLinks of [null, 'true', 1])
    assert.throws(() => readUnboundedFile(file, () => Error('invalid'), { allowLinks }), TypeError);
});
