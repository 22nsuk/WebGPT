import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile), cli = realpathSync.native(fileURLToPath(new URL('./client.mjs', import.meta.url)));
async function fixture(t, { live = false, preload = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-wait-input-')), requests = [];
  const file = join(dir, 'config.json');
  let server, worker, observer, port;
  t.after(async () => {
    observer?.mock.restore();
    await worker?.close();
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    rmSync(dir, { recursive: true, force: true });
  });
  const observe = req => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: url.pathname, ids: url.searchParams.getAll('id') });
  };
  writeFileSync(join(dir, 'controller.key'), 'test-controller-key');
  if (live) {
    const { start } = await import('./worker.mjs');
    worker = await start({ dir, port: 0, controlPort: 0, configFile: file, waitMs: 20, closeGraceMs: 50 });
    port = worker.controlPort;
    const emit = Server.prototype.emit;
    observer = t.mock.method(Server.prototype, 'emit', function(event, ...args) {
      const result = Reflect.apply(emit, this, [event, ...args]);
      if (event === 'request' && this.address()?.port === port && args[0].url.startsWith('/wait')) observe(args[0]);
      return result;
    });
  } else {
    server = createServer((req, res) => {
      observe(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ events: [], backupDue: [], settled: true }));
    });
    const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
    port = server.address().port;
  }
  const config = { dataDir: dir, controlPort: port, mcpPort: worker?.mcpPort ?? (port === 43137 ? 43138 : 43137) };
  writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  let entry = cli;
  if (preload) {
    const alias = join(dir, 'scripts 한글 # %');
    symlinkSync(dirname(cli), alias, process.platform === 'win32' ? 'junction' : 'dir');
    entry = join(alias, 'client.mjs'); env.NODE_OPTIONS = '--import=' + pathToFileURL(cli).href;
  }
  return { dir, requests, config, async run(...args) {
    const options = { cwd: dir, env, timeout: 15000, windowsHide: true };
    const flags = preload ? ['--preserve-symlinks', '--preserve-symlinks-main'] : [];
    try { return { code: 0, ...await execute(process.execPath, [...flags, entry, 'wait', ...args], options) }; }
    catch (error) {
      // Only the expected CLI refusal is a result, not a timeout or launch failure.
      assert.equal(error.code, 1); assert.equal(error.signal, null); assert.equal(error.killed, false);
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  } };
}

for (const value of [null, false, 0, '']) {
  test(`wait --file rejects ${JSON.stringify(value)} without selecting CLI words as task IDs`, async t => {
    const f = await fixture(t), file = join(f.dir, 'payload'), bytes = JSON.stringify(value);
    // Both '--file' and this basename are legal task-ID spellings. A truthiness
    // fallback can therefore issue a real request and even report settled success.
    writeFileSync(file, bytes);
    const result = await f.run('--file', 'payload');
    if (result.code !== 1) t.diagnostic(JSON.stringify({ code: result.code, requests: f.requests }));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /wait input must be an object/);
    assert.deepEqual(f.requests, []);
    assert.equal(readFileSync(file, 'utf8'), bytes);
  });
}

test('wait file mode rejects other invalid payload shapes before controller access', async t => {
  const f = await fixture(t);
  for (const value of [true, 1, 'chosen', ['chosen'], {}, { id: null }, { ids: [] }]) {
    writeFileSync(join(f.dir, 'payload'), JSON.stringify(value));
    const result = await f.run('--file', 'payload');
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /WebGPT: /);
  }
  assert.deepEqual(f.requests, []);
});

test('explicit and legacy wait files select only their saved IDs and preserve duplicate normalization', async t => {
  const f = await fixture(t);
  const cases = [
    { args: ['--file', 'payload'], body: { id: 'chosen', token: 'unused-registration-field' }, ids: ['chosen'] },
    { args: ['--file', 'payload'], body: { ids: ['b', 'a', 'b'] }, ids: ['b', 'a'] },
    { args: ['./payload'], body: { id: 'legacy' }, ids: ['legacy'] },
  ];
  for (const { args, body, ids } of cases) {
    writeFileSync(join(f.dir, 'payload'), JSON.stringify(body));
    const result = await f.run(...args);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { events: [], backupDue: [], settled: true });
    assert.deepEqual(f.requests.at(-1), { method: 'GET', path: '/wait', ids });
  }
  assert.equal(f.requests.length, cases.length);
});

test('direct wait IDs do not read a same-named file or become JSON file mode', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.dir, 'null'), JSON.stringify({ id: 'wrong-task' }));
  for (const args of [['null'], ['null', 'other', 'null']]) {
    const result = await f.run(...args);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
  }
  assert.deepEqual(f.requests, [
    { method: 'GET', path: '/wait', ids: ['null'] },
    { method: 'GET', path: '/wait', ids: ['null', 'other'] },
  ]);
});

for (const preload of [false, true]) test(`integration: wait file scope uses the real worker with ${preload ? 'preloaded alias' : 'ordinary entry'}`, async t => {
  const f = await fixture(t, { live: true, preload }), { request } = await import('./client.mjs');
  // These decoys make the old fallback a real successful wait, not just an
  // unknown-task error. The CLI must reject before querying either decoy.
  for (const id of ['--file', 'payload', 'chosen']) {
    await request('register', { id, instructions: 'fixture only', inputs: {} }, f.config);
    await request('cancel', { id }, f.config);
  }
  const retained = ['state.json', 'config.json', 'controller.key'].map(name => [join(f.dir, name), readFileSync(join(f.dir, name))]);
  const payload = join(f.dir, 'payload'); writeFileSync(payload, 'null');
  const rejected = await f.run('--file', 'payload');
  if (rejected.code !== 1) t.diagnostic(JSON.stringify({ code: rejected.code, requests: f.requests }));
  assert.equal(rejected.code, 1); assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /wait input must be an object/);
  assert.deepEqual(f.requests, []); assert.equal(readFileSync(payload, 'utf8'), 'null');
  writeFileSync(payload, JSON.stringify({ id: 'chosen' }));
  const accepted = await f.run('--file', 'payload');
  assert.equal(accepted.code, 0); assert.equal(accepted.stderr, '');
  assert.deepEqual(JSON.parse(accepted.stdout), { events: [], backupDue: [], settled: true });
  assert.deepEqual(f.requests, [{ method: 'GET', path: '/wait', ids: ['chosen'] }]);
  for (const [file, before] of retained) assert.deepEqual(readFileSync(file), before);
});
