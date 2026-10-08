import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { configuration, request, retryableControllerError } from './client.mjs';
import { readBoundedFile } from './bounded-read.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const execute = promisify(execFile);
const clientUrl = new URL('./client.mjs', import.meta.url);
const adapters = [
  { name: 'configuration', filename: 'config.json', limit: 64 * 1024, text: '{}',
    read: dir => configuration({ WEBGPT_CONFIG: join(dir, 'config.json') }) },
  { name: 'controller key', filename: 'controller.key', limit: 4096, text: 'custom:key',
    read: dir => request('status', undefined, { dataDir: dir, controlPort: 1 }) },
];
const denyNetwork = t => t.mock.method(globalThis, 'fetch', () => { throw Error('unexpected controller request'); });
const invalidFile = { code: 'CONFIG_INVALID' };

for (const adapter of adapters) {
  test(`${adapter.name}: oversized metadata is rejected before content I/O or HTTP`, async t => {
    const dir = readFixture(t), file = join(dir, adapter.filename);
    const bytes = Buffer.from(adapter.text + ' '.repeat(adapter.limit + 1 - adapter.text.length));
    fs.writeFileSync(file, bytes);
    const network = denyNetwork(t), observed = observeFileRead(t, file);
    try { await assert.rejects(async () => adapter.read(dir), invalidFile); }
    finally { observed.restore(); }
    assert.deepEqual(observed.evidence, { opens: 0, closes: 0, bytes: 0, reads: 0 });
    assert.equal(network.mock.callCount(), 0);
    assert.deepEqual(fs.readFileSync(file), bytes);
  });

  test(`${adapter.name}: exact allowance survives short reads without truncation`, async t => {
    const dir = readFixture(t), file = join(dir, adapter.filename);
    const text = adapter.name === 'configuration' ? '{}'.padEnd(adapter.limit) : 'k'.repeat(adapter.limit);
    fs.writeFileSync(file, text);
    const network = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(options.headers.authorization, 'Bearer ' + text);
      return { ok: true, json: async () => ({ accepted: true }) };
    });
    const observed = observeFileRead(t, file, { chunkSize: 317 });
    try {
      const result = await adapter.read(dir);
      assert.equal(adapter.name === 'configuration' ? result.mcpPort : result.accepted,
        adapter.name === 'configuration' ? 43137 : true);
    } finally { observed.restore(); }
    assert.equal(observed.evidence.bytes, adapter.limit);
    assert.equal(observed.evidence.opens, 1);
    assert.equal(observed.evidence.closes, 1);
    assert.ok(observed.evidence.reads > 1);
    assert.equal(network.mock.callCount(), adapter.name === 'configuration' ? 0 : 1);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  });

  test(`${adapter.name}: growth is rejected after only allowance plus one bytes`, async t => {
    const dir = readFixture(t), file = join(dir, adapter.filename);
    fs.writeFileSync(file, adapter.text);
    const grown = adapter.text + ' '.repeat(adapter.limit * 2);
    const network = denyNetwork(t);
    const observed = observeFileRead(t, file, { afterStat: () => fs.writeFileSync(file, grown) });
    try { await assert.rejects(async () => adapter.read(dir), invalidFile); }
    finally { observed.restore(); }
    assert.equal(observed.evidence.bytes, adapter.limit + 1);
    assert.equal(observed.evidence.opens, 1);
    assert.equal(observed.evidence.closes, 1);
    assert.equal(network.mock.callCount(), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), grown);
  });

  test(`${adapter.name}: same-byte replacement at open is not the observed file`, async t => {
    const dir = readFixture(t), file = join(dir, adapter.filename), original = file + '.original';
    fs.writeFileSync(file, adapter.text);
    const network = denyNetwork(t);
    const observed = observeFileRead(t, file, { beforeOpen: () => {
      fs.renameSync(file, original); fs.writeFileSync(file, adapter.text);
    } });
    try { await assert.rejects(async () => adapter.read(dir), invalidFile); }
    finally { observed.restore(); }
    assert.equal(observed.evidence.bytes, 0);
    assert.equal(observed.evidence.opens, 1);
    assert.equal(observed.evidence.closes, 1);
    assert.equal(network.mock.callCount(), 0);
    assert.equal(fs.readFileSync(file, 'utf8'), adapter.text);
    assert.equal(fs.readFileSync(original, 'utf8'), adapter.text);
  });

  for (const [hook, code, opens] of [['beforeOpen', 'EACCES', 0], ['beforeRead', 'EIO', 1], ['beforeOpen', 'ENOENT', 0]])
    test(`${adapter.name}: ${hook} ${code} is propagated without HTTP or repair`, async t => {
      const dir = readFixture(t), file = join(dir, adapter.filename);
      fs.writeFileSync(file, adapter.text);
      const failure = Object.assign(Error('injected read failure'), { code });
      const network = denyNetwork(t);
      const observed = observeFileRead(t, file, { [hook]: () => { throw failure; } });
      try { await assert.rejects(async () => adapter.read(dir), error => error === failure); }
      finally { observed.restore(); }
      assert.equal(observed.evidence.opens, opens);
      assert.equal(observed.evidence.closes, opens);
      assert.equal(network.mock.callCount(), 0);
      assert.equal(retryableControllerError(failure), false);
      assert.equal(fs.readFileSync(file, 'utf8'), adapter.text);
    });

  test(`${adapter.name}: a directory is rejected without modifying it`, async t => {
    const dir = readFixture(t), file = join(dir, adapter.filename);
    fs.mkdirSync(file);
    const network = denyNetwork(t);
    await assert.rejects(async () => adapter.read(dir), invalidFile);
    assert.deepEqual(fs.readdirSync(file), []);
    assert.equal(network.mock.callCount(), 0);
  });
}

test('configuration preserves defaults, explicit overrides and initial absence only', t => {
  const dir = readFixture(t), file = join(dir, '.config', 'webgpt', 'config.json');
  const home = t.mock.method(os, 'homedir', () => dir);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(configuration({}), { dataDir: join(dir, '.local', 'share', 'webgpt'),
      mcpPort: 43137, controlPort: 43139, publicMcp: false });
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), /file does not exist/);
    assert.throws(() => configuration({}, { requireExplicitDataDir: true }), /explicit dataDir/);
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.mkdirSync(join(dir, '.config', 'webgpt'), { recursive: true });
    const saved = { dataDir: join(dir, '한글'), mcpPort: 12340, controlPort: 12341, publicMcp: true };
    const bytes = Buffer.from('\ufeff' + JSON.stringify(saved));
    fs.writeFileSync(file, bytes);
    assert.deepEqual(configuration({}), saved);
    assert.equal(configuration({ WEBGPT_DATA_DIR: dir }, { requireExplicitDataDir: true }).dataDir, dir);
    const failure = Object.assign(Error('late disappearance'), { code: 'ENOENT' });
    const observed = observeFileRead(t, file, { beforeOpen: () => { throw failure; } });
    try { assert.throws(() => configuration({}), error => error === failure); }
    finally { observed.restore(); }
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally { home.mock.restore(); syncBuiltinESMExports(); }
});

test('bounded configuration retains strict UTF-8/JSON decoding and structural validation', t => {
  const dir = readFixture(t), file = join(dir, 'config.json');
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.from('{}', 'utf16le'),
    Buffer.from('\ufeff\ufeff{}')]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), /invalid JSON or UTF-8 input file/);
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  for (const value of [null, [], { publicMcp: 'true' }, { dataDir: 'relative' }, { mcpPort: 43139 }]) {
    const bytes = JSON.stringify(value); fs.writeFileSync(file, bytes);
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }));
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

for (const link of ['hardlink', 'symlink']) test(`configuration keeps ${link} compatibility; private keys remain single-link`, async t => {
  const dir = readFixture(t), file = join(dir, 'config.json'), target = join(dir, 'source');
  const bytes = '{"publicMcp":true}'; fs.writeFileSync(target, bytes);
  try {
    if (link === 'hardlink') fs.linkSync(target, file); else fs.symlinkSync(target, file, 'file');
  } catch (error) {
    if (link === 'symlink' && process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('file symlink privilege unavailable'); return;
    }
    throw error;
  }
  assert.equal(configuration({ WEBGPT_CONFIG: file }).publicMcp, true);
  fs.renameSync(file, join(dir, 'controller.key'));
  const network = denyNetwork(t);
  await assert.rejects(request('status', undefined, { dataDir: dir, controlPort: 1 }), invalidFile);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
  assert.equal(fs.readFileSync(join(dir, 'controller.key'), 'utf8'), bytes);
});

test('a missing parent key is ENOENT, not a request or permission to create a key', async t => {
  const dir = readFixture(t), network = denyNetwork(t);
  await assert.rejects(request('status', undefined, { dataDir: dir, controlPort: 1 }), { code: 'ENOENT' });
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('only a boolean explicit link opt-in can relax the shared reader', t => {
  const file = join(readFixture(t), 'missing');
  for (const allowLinks of [null, 0, 1, 'true', {}])
    assert.throws(() => readBoundedFile(file, 4, () => Error('invalid'), { allowLinks }), TypeError);
});

for (const adapter of adapters) for (const atOpen of [false, true])
  test(`${adapter.name}: writerless FIFO ${atOpen ? 'substitution at open' : 'input'} returns before the external watchdog`,
    { skip: process.platform === 'win32' }, async t => {
      const dir = readFixture(t), file = join(dir, adapter.filename);
      if (atOpen) fs.writeFileSync(file, adapter.text); else execFileSync('mkfifo', [file]);
      const script = `
        import fs from 'node:fs';
        import { execFileSync } from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { configuration, request } from ${JSON.stringify(clientUrl.href)};
        const file = ${JSON.stringify(file)};
        if (${atOpen}) {
          const open = fs.openSync;
          fs.openSync = (path, ...args) => {
            if (path === file) { fs.renameSync(file, file + '.original'); execFileSync('mkfifo', [file]); }
            return open(path, ...args);
          };
          syncBuiltinESMExports();
        }
        try {
          if (${JSON.stringify(adapter.name)} === 'configuration') configuration({ WEBGPT_CONFIG: file });
          else await request('status', undefined, { dataDir: ${JSON.stringify(dir)}, controlPort: 1 }, { timeoutMs: 25 });
          throw Error('unexpected success');
        } catch (error) {
          if (error.code !== 'CONFIG_INVALID') throw error;
          console.log(error.code);
        }
      `;
      const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e', script],
        { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 });
      assert.equal(stdout.trim(), 'CONFIG_INVALID');
      assert.equal(stderr, '');
      assert.equal(fs.lstatSync(file).isFIFO(), true);
      if (atOpen) assert.equal(fs.readFileSync(file + '.original', 'utf8'), adapter.text);
    });

test('real client CLI sends a larger task JSON and an unchanged custom key over loopback', async t => {
  const dir = readFixture(t), key = 'custom/non-UUID:key-é';
  fs.writeFileSync(join(dir, 'controller.key'), key);
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"accepted":true}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const file = join(dir, 'config.json'), input = join(dir, 'task.json');
    fs.writeFileSync(file, '\ufeff' + JSON.stringify({ dataDir: dir, controlPort: server.address().port,
      mcpPort: server.address().port === 43137 ? 43138 : 43137 }));
    const payload = { id: 'large-input', instructions: 'Review only', inputs: { source: 'x'.repeat(128 * 1024) } };
    fs.writeFileSync(input, '\ufeff' + JSON.stringify(payload));
    const { stdout, stderr } = await execute(process.execPath, [fileURLToPath(clientUrl), 'register', input], {
      env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir }, timeout: 10000,
    });
    assert.deepEqual(JSON.parse(stdout), { accepted: true }); assert.equal(stderr, '');
    assert.equal(received.length, 1); assert.equal(received[0].url, '/register');
    assert.equal(received[0].authorization, 'Bearer ' + key);
    assert.deepEqual(JSON.parse(received[0].body), payload);
    assert.equal(fs.readFileSync(join(dir, 'controller.key'), 'utf8'), key);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
