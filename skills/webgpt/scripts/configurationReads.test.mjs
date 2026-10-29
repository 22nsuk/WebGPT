import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectsRequest } from './test-fixtures/request-error.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { configuration, configurationFile, request, retryableControllerError } from './client.mjs';
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

test('configuration path validation classifies its own errors without exposing the selected path', t => {
  const dir = readFixture(t), network = denyNetwork(t);
  for (const file of ['private-relative-config.json', 42, join(dir, '\ud800-private-config.json')]) {
    const expected = { code: 'CONFIG_INVALID', message: 'WEBGPT_CONFIG must be absolute' };
    assert.throws(() => configurationFile({ WEBGPT_CONFIG: file }), expected);
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), expected);
  }
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

for (const source of ['WEBGPT_CONFIG', 'WEBGPT_DATA_DIR', 'saved dataDir'])
  test(`common configuration rejects NUL in ${source} before native path I/O`, async t => {
    const dir = readFixture(t), file = join(dir, 'config.json'), runtime = join(dir, 'private-runtime');
    const invalid = (source === 'WEBGPT_CONFIG' ? file : runtime) + '\0private-path-suffix';
    const env = { WEBGPT_CONFIG: source === 'WEBGPT_CONFIG' ? invalid : file };
    if (source === 'WEBGPT_DATA_DIR') env.WEBGPT_DATA_DIR = invalid;
    const bytes = Buffer.from(JSON.stringify({ dataDir: source === 'saved dataDir' ? invalid : runtime }));
    fs.writeFileSync(file, bytes);
    const network = denyNetwork(t), configMetadata = t.mock.method(fs, 'statSync');
    const runtimeMetadata = t.mock.method(fs, 'lstatSync'), runtimeCreation = t.mock.method(fs, 'mkdirSync');
    const observed = observeFileRead(t, file);
    try {
      const expected = { code: 'CONFIG_INVALID', retryable: false,
        message: `${source === 'WEBGPT_CONFIG' ? source : 'dataDir'} must not contain NUL` };
      const reject = error => {
        assert.equal(error.code, expected.code); assert.equal(error.message, expected.message);
        assert.equal(error.retryable, false); assert.equal(retryableControllerError(error), false);
        assert.equal(error.cause, undefined); assert.ok(!error.stack.includes(dir));
        assert.ok(!error.stack.includes('private-path-suffix')); return true;
      };
      assert.throws(() => configuration(env), reject);
      await assert.rejects(async () => request('status', undefined, configuration(env)), reject);
      if (source === 'WEBGPT_CONFIG') {
        assert.throws(() => configurationFile(env), reject);
        assert.equal(configMetadata.mock.callCount(), 0);
        assert.deepEqual(observed.evidence, { opens: 0, closes: 0, bytes: 0, reads: 0 });
      } else {
        assert.ok(configMetadata.mock.calls.every(call => call.arguments[0] === file));
      }
      assert.equal(runtimeMetadata.mock.callCount(), 0);
      assert.equal(runtimeCreation.mock.callCount(), 0);
      assert.equal(network.mock.callCount(), 0);
    } finally {
      configMetadata.mock.restore(); runtimeMetadata.mock.restore(); runtimeCreation.mock.restore(); observed.restore();
    }
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  });

for (const separator of ['\\', '/']) for (const source of ['WEBGPT_CONFIG', 'WEBGPT_DATA_DIR', 'saved dataDir'])
  test(`Windows common configuration rejects drive-less ${source} with ${separator} separators`,
    { skip: process.platform !== 'win32' }, t => {
      const dir = readFixture(t), file = join(dir, 'config.json'), runtime = join(dir, 'runtime');
      assert.match(dir, /^[A-Za-z]:\\/, 'drive-backed fixture required to reproduce current-drive selection');
      const rooted = path => path.slice(2).replaceAll('\\', separator);
      const env = { WEBGPT_CONFIG: source === 'WEBGPT_CONFIG' ? rooted(file) : file };
      if (source === 'WEBGPT_DATA_DIR') env.WEBGPT_DATA_DIR = rooted(runtime);
      const bytes = JSON.stringify({ dataDir: source === 'saved dataDir' ? rooted(runtime) : runtime });
      fs.writeFileSync(file, bytes);
      const cwd = process.cwd(), network = denyNetwork(t);
      process.chdir(dir);
      try {
        // The pre-fix loader can read this real fixture through its drive-less spelling.
        assert.equal(fs.readFileSync(rooted(file), 'utf8'), bytes);
        const observed = observeFileRead(t, env.WEBGPT_CONFIG), metadata = t.mock.method(fs, 'statSync');
        syncBuiltinESMExports();
        try {
          const expected = { code: 'CONFIG_INVALID', retryable: false,
            message: `${source === 'WEBGPT_CONFIG' ? source : 'dataDir'} must be fully qualified` };
          assert.throws(() => configuration(env), expected);
          if (source === 'WEBGPT_CONFIG') {
            assert.throws(() => configurationFile(env), expected);
            assert.equal(metadata.mock.callCount(), 0);
            assert.deepEqual(observed.evidence, { opens: 0, closes: 0, bytes: 0, reads: 0 });
          }
        } finally { metadata.mock.restore(); observed.restore(); }
        assert.equal(network.mock.callCount(), 0);
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
        assert.deepEqual(fs.readdirSync(dir), ['config.json']);
      } finally { process.chdir(cwd); }
    });

test('Windows common configuration rejects bare and incomplete UNC roots', { skip: process.platform !== 'win32' }, t => {
  const dir = readFixture(t), file = join(dir, 'config.json'), network = denyNetwork(t);
  for (const path of ['\\', '/', '\\\\server', '//server']) {
    assert.throws(() => configurationFile({ WEBGPT_CONFIG: path }), {
      code: 'CONFIG_INVALID', retryable: false, message: 'WEBGPT_CONFIG must be fully qualified',
    });
    const bytes = JSON.stringify({ dataDir: path }); fs.writeFileSync(file, bytes);
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), {
      code: 'CONFIG_INVALID', retryable: false, message: 'dataDir must be fully qualified',
    });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('common configuration preserves qualified native path spellings and selected overrides', t => {
  const dir = readFixture(t), file = join(dir, 'config.json'), runtime = join(dir, '한글-runtime');
  const qualify = process.platform === 'win32'
    ? [path => path, path => path.replaceAll('\\', '/'), toNamespacedPath] : [path => path];
  const network = denyNetwork(t);
  for (const format of qualify) {
    const env = { WEBGPT_CONFIG: format(file) }, saved = { dataDir: format(runtime) };
    const bytes = JSON.stringify(saved); fs.writeFileSync(file, bytes);
    assert.equal(configurationFile(env), env.WEBGPT_CONFIG);
    assert.equal(configuration(env, { requireExplicitDataDir: true }).dataDir, saved.dataDir);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    for (const dataDir of [process.platform === 'win32' ? '\\ignored-runtime' : 'ignored-runtime', runtime + '\0ignored-suffix']) {
      const ignored = JSON.stringify({ dataDir }); fs.writeFileSync(file, ignored);
      env.WEBGPT_DATA_DIR = format(runtime);
      assert.equal(configuration(env, { requireExplicitDataDir: true }).dataDir, env.WEBGPT_DATA_DIR);
      assert.equal(fs.readFileSync(file, 'utf8'), ignored);
    }
  }
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('Windows common configuration admits qualified UNC spellings without resolving a share',
  { skip: process.platform !== 'win32' }, t => {
    const dir = readFixture(t), file = join(dir, 'config.json'), network = denyNetwork(t);
    for (const path of ['\\\\server\\share\\webgpt', '//server/share/webgpt', '\\\\?\\UNC\\server\\share\\webgpt']) {
      assert.equal(configurationFile({ WEBGPT_CONFIG: path }), path);
      const bytes = JSON.stringify({ dataDir: path }); fs.writeFileSync(file, bytes);
      assert.equal(configuration({ WEBGPT_CONFIG: file }).dataDir, path);
      assert.equal(configuration({ WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: path }).dataDir, path);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    }
    assert.equal(network.mock.callCount(), 0);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  });

test('configuration preserves defaults, explicit overrides and initial absence only', t => {
  const dir = readFixture(t), file = join(dir, '.config', 'webgpt', 'config.json');
  const home = t.mock.method(os, 'homedir', () => dir);
  syncBuiltinESMExports();
  try {
    assert.deepEqual(configuration({}), { dataDir: join(dir, '.local', 'share', 'webgpt'),
      mcpPort: 43137, controlPort: 43139, publicMcp: false });
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), {
      code: 'CONFIG_INVALID', message: 'WEBGPT_CONFIG file does not exist',
    });
    assert.throws(() => configuration({}, { requireExplicitDataDir: true }), {
      code: 'CONFIG_INVALID', message: 'explicit dataDir required',
    });
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
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), {
      code: 'CONFIG_INVALID', message: 'invalid JSON or UTF-8 input file',
    });
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
  for (const [value, message] of [
    [null, 'invalid WebGPT configuration'], [[], 'invalid WebGPT configuration'],
    [{ publicMcp: 'true' }, 'publicMcp must be boolean'],
    [{ dataDir: 'relative' }, 'dataDir must be absolute'],
    [{ mcpPort: 65536 }, 'invalid mcpPort'], [{ controlPort: 0 }, 'invalid controlPort'],
    [{ mcpPort: 43139 }, 'MCP and controller ports must differ'],
  ]) {
    const bytes = JSON.stringify(value); fs.writeFileSync(file, bytes);
    assert.throws(() => configuration({ WEBGPT_CONFIG: file }), { code: 'CONFIG_INVALID', message });
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
  await rejectsRequest(request('status', undefined, { dataDir: dir, controlPort: 1 }), invalidFile);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
  assert.equal(fs.readFileSync(join(dir, 'controller.key'), 'utf8'), bytes);
});

test('a missing parent key is ENOENT, not a request or permission to create a key', async t => {
  const dir = readFixture(t), network = denyNetwork(t);
  await rejectsRequest(request('status', undefined, { dataDir: dir, controlPort: 1 }), { code: 'ENOENT' });
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('parent API and real CLI reject invalid controller key text without requests or secret diagnostics', async t => {
  const dir = readFixture(t), keyFile = join(dir, 'controller.key'), marker = 'PRIVATE_FIXTURE_KEY';
  const stateFile = join(dir, 'state.json'), state = '[\n]\n';
  fs.writeFileSync(stateFile, state);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const config = { dataDir: dir, controlPort: server.address().port,
      mcpPort: server.address().port === 43137 ? 43138 : 43137 };
    const file = join(dir, 'config.json'), configBytes = JSON.stringify(config); fs.writeFileSync(file, configBytes);
    for (const [name, text] of [['empty', ''], ['trailing space', marker + ' '], ['trailing tab', marker + '\t'],
      ['trailing newline', marker + '\n'], ['interior newline', marker + '\nx'], ['interior CR', marker + '\rx'],
      ['NUL', marker + '\0'], ['DEL', marker + '\x7f'], ['wide Unicode', marker + '한글'],
      ['invalid UTF-8', Buffer.concat([Buffer.from(marker), Buffer.from([0xff])])]]) {
      await t.test(name, async t => {
        const bytes = Buffer.from(text); fs.writeFileSync(keyFile, bytes);
        await t.test('API', async () => {
          await assert.rejects(request('status', undefined, config), error => {
            assert.equal(error.code, 'CONFIG_INVALID'); assert.equal(error.message, 'invalid controller.key');
            assert.equal(error.cause, undefined); assert.equal(error.stack.includes(marker), false);
            assert.equal(retryableControllerError(error), false); return true;
          });
        });
        await t.test('CLI', async () => {
          await assert.rejects(execute(process.execPath, [fileURLToPath(clientUrl), 'status'], {
            env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir }, timeout: 10000,
          }), error => {
            assert.equal(error.code, 1); assert.equal(error.stdout, '');
            assert.equal(error.stderr.trim(), 'WebGPT: invalid controller.key'); return true;
          });
        });
        assert.deepEqual(fs.readFileSync(keyFile), bytes);
        assert.equal(fs.readFileSync(stateFile, 'utf8'), state);
        assert.equal(fs.readFileSync(file, 'utf8'), configBytes);
        assert.equal(requests, 0, 'invalid key text must not reach the controller');
      });
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
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

for (const [name, key] of [['Latin-1', 'custom/non-UUID:key-é'], ['obs-text', 'fixture-\x80\xff'],
  ['spaces and tab', ' fixture\twith space']])
test(`real client CLI sends a larger task JSON and unchanged ${name} key over loopback`, async t => {
  const dir = readFixture(t);
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
