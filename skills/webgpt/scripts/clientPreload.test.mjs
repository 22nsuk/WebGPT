import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// A canonical preload must not inherit an aliased checkout/test-module spelling.
const script = fs.realpathSync.native(fileURLToPath(new URL('./client.mjs', import.meta.url)));
const moduleUrl = pathToFileURL(script).href;
const layouts = [[], ['--preserve-symlinks-main'], ['--preserve-symlinks', '--preserve-symlinks-main']];
async function fixture(t, rejected = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'webgpt-client-preload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const alias = join(dir, 'scripts 한글 # %');
  fs.symlinkSync(dirname(script), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const requests = [], key = 'fixture-only-controller-key';
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('error', () => res.destroy());
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(rejected ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rejected ? { error: 'capacity fixture', code: 'HTTP_BODY_BUSY', retryable: true } : { ok: true }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const data = join(dir, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(join(data, 'controller.key'), key);
  const config = join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ dataDir: data, mcpPort: server.address().port === 43137 ? 43138 : 43137,
    controlPort: server.address().port }));
  const before = fs.readFileSync(config);
  const run = (args, nodeOptions) => new Promise((resolve, reject) => {
    const env = { ...process.env, WEBGPT_CONFIG: config, WEBGPT_DATA_DIR: data };
    delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
    if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
    const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(Error('client preload fixture timed out'));
      resolve({ status, signal, stdout, stderr });
    });
  });
  const unchanged = () => {
    assert.deepEqual(fs.readFileSync(config), before);
    assert.deepEqual(fs.readdirSync(data), ['controller.key']);
    assert.equal(fs.readFileSync(join(data, 'controller.key'), 'utf8'), key);
  };
  return { dir, alias: join(alias, 'client.mjs'), requests, run, unchanged, expectedRequest: {
    method: 'POST', url: '/checked', authorization: 'Bearer ' + key, body: '{"id":"preload-task"}',
  } };
}

for (const rejected of [false, true]) for (const flags of layouts) for (const preload of ['none', 'CLI', 'NODE_OPTIONS']) {
  test(`client entry sends once: ${rejected ? 'refused' : 'accepted'}, ${flags.join(' ') || 'canonical'}, ${preload}`, async t => {
    const f = await fixture(t, rejected);
    const entry = flags.length ? f.alias : script;
    const result = await f.run([...flags, ...(preload === 'CLI' ? ['--import', moduleUrl] : []), entry, 'checked', 'preload-task'],
      preload === 'NODE_OPTIONS' ? '--import=' + moduleUrl : undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, rejected ? 1 : 0, result.stderr);
    assert.deepEqual(f.requests, [f.expectedRequest], 'one explicit command must send exactly one request, including refusals');
    assert.equal(result.stdout, rejected ? '' : '{"ok":true}\n');
    assert.equal(result.stderr, rejected ? 'WebGPT: capacity fixture\n' : '');
    f.unchanged();
  });
}

test('client preloads for an unrelated entry and eval arguments remain import-only', async t => {
  const f = await fixture(t);
  const other = join(f.dir, 'other.mjs'); fs.writeFileSync(other, "console.log('OTHER');\n");
  assert.deepEqual(await f.run(['--import', moduleUrl, other, 'checked', 'preload-task']),
    { status: 0, signal: null, stdout: 'OTHER\n', stderr: '' });
  assert.deepEqual(await f.run(['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`, script, 'checked', 'preload-task']),
    { status: 0, signal: null, stdout: '', stderr: '' });
  assert.deepEqual(f.requests, []); f.unchanged();
});

test('client entry lookup failure is private and cannot retry through a later main alias', async t => {
  const f = await fixture(t), hook = join(f.dir, 'lookup-hook.mjs');
  fs.writeFileSync(hook, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\n` +
    `const native=fs.realpathSync.native;\nfs.realpathSync.native=(path, options)=>{\n` +
    `if(path===${JSON.stringify(script)}) throw Object.assign(Error('private lookup evidence'),{code:'EIO'});\n` +
    `return native(path,options);};\nsyncBuiltinESMExports();\n` +
    `await import(${JSON.stringify(moduleUrl)});\nfs.realpathSync.native=native;\nsyncBuiltinESMExports();\n`);
  const result = await f.run(['--preserve-symlinks', '--preserve-symlinks-main', '--import', pathToFileURL(hook).href,
    f.alias, 'checked', 'preload-task']);
  assert.deepEqual(result, { status: 1, signal: null, stdout: '', stderr:
    'WebGPT: {"code":"CLI_ENTRY_UNAVAILABLE","message":"Client entry unavailable; no command was run."}\n' });
  assert.deepEqual(f.requests, []); f.unchanged();
});

test('client refuses a failed execution claim before sending a command', async t => {
  const f = await fixture(t), hook = join(f.dir, 'claim-hook.mjs');
  fs.writeFileSync(hook, "Object.defineProperty(process, Symbol.for('webgpt.client.cli-executed'), {value:false});\n");
  const result = await f.run(['--import', pathToFileURL(hook).href, script, 'checked', 'preload-task']);
  assert.equal(result.status, 1); assert.equal(result.signal, null); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'WebGPT: {"code":"CLI_ENTRY_UNAVAILABLE","message":"Client entry unavailable; no command was run."}\n');
  assert.deepEqual(f.requests, []); f.unchanged();
});
