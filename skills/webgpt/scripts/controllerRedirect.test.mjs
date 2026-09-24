// Real HTTP, disposable runtimes and loopback destinations only. No external traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { request, waitForTasks, collectTask, retryableControllerError } from './client.mjs';
import { start } from './worker.mjs';

const execute = promisify(execFile);
const privateText = 'PRIVATE_REDIRECT_FIXTURE';
const payload = { id: 'owned', instructions: '검토 🧪 ' + privateText, inputs: { sample: privateText } };
const resultBytes = 'Retained result 한국어 🧪';
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
};
async function server(t, handler) {
  const failures = [], instance = createServer((req, res) => {
    Promise.resolve().then(async () => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      await handler(req, res, Buffer.concat(chunks));
    }).catch(error => { failures.push(error); res.destroy(); });
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise(resolve => instance.close(resolve));
    assert.deepEqual(failures, []);
  });
  return { port: instance.address().port, url: `http://127.0.0.1:${instance.address().port}` };
}
function directory(t, beforeCleanup = () => {}) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'webgpt-controller-redirect-')));
  t.after(async () => { await beforeCleanup(); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function redirectFailure(error) {
  // Native fetch's nested diagnostic text is implementation-specific. Verify the
  // public failure and retry policy, not an Undici version's cause/message spelling.
  assert.equal(error.name, 'TypeError');
  assert.equal(retryableControllerError(error), false);
  assert.ok(!error.message.includes(privateText));
  return true;
}

for (const status of [301, 302, 303, 307, 308]) for (const scope of ['same-origin', 'other-port']) {
  for (const action of ['status', 'register']) test(`${action} refuses ${status} ${scope} redirects before visiting the target`, async t => {
    const dir = directory(t), key = 'fixture-only-controller-key';
    writeFileSync(join(dir, 'controller.key'), key);
    let visits = 0, originals = 0;
    const destination = await server(t, (_req, res) => { visits++; json(res, { ok: true }); });
    const controller = await server(t, (req, res, body) => {
      if (req.url.startsWith('/target')) { visits++; json(res, { ok: true }); return; }
      originals++;
      assert.equal(req.url, '/' + action);
      assert.equal(req.headers.authorization, 'Bearer ' + key);
      assert.equal(req.method, action === 'register' ? 'POST' : 'GET');
      assert.equal(body.toString(), action === 'register' ? JSON.stringify(payload) : '');
      const location = (scope === 'same-origin' ? '' : destination.url) + '/target?' + privateText;
      res.writeHead(status, { location }); res.end(privateText);
    });
    await assert.rejects(request(action, action === 'register' ? payload : undefined,
      { dataDir: dir, controlPort: controller.port }), redirectFailure);
    assert.equal(originals, 1); assert.equal(visits, 0);
    assert.equal(readFileSync(join(dir, 'controller.key'), 'utf8'), key);
  });
}

test('task-scoped wait does not accept a redirected snapshot or retry the original request', async t => {
  const dir = directory(t); writeFileSync(join(dir, 'controller.key'), 'fixture-only-key');
  let originals = 0, visits = 0;
  const controller = await server(t, (req, res) => {
    if (req.url.startsWith('/wait?')) {
      originals++; res.writeHead(302, { location: '/target' }); res.end(); return;
    }
    visits++; json(res, { events: [], backupDue: [], settled: true });
  });
  await assert.rejects(waitForTasks(['owned'], { dataDir: dir, controlPort: controller.port },
    { retryDelays: [0, 0, 0] }), redirectFailure);
  assert.equal(originals, 1); assert.equal(visits, 0);
});

async function workerFixture(t) {
  let worker;
  const dir = directory(t, () => worker?.close());
  worker = await start({ dir, port: 0, controlPort: 0, waitMs: 20 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  const task = await request('register', payload, config);
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json')))[0];
  const complete = async () => {
    const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'submit_result', arguments: { token: task.token, status: 'completed', summary: 'done', result: resultBytes },
      } }),
    });
    assert.equal((await response.json()).result.isError, false);
  };
  const forward = async (req, res, bytes) => {
    // Forward only to this fixture's fixed worker, never to a Location header.
    const response = await fetch(`http://127.0.0.1:${worker.controlPort}${req.url}`, {
      method: req.method, headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
      ...(req.method === 'POST' ? { body: bytes } : {}), redirect: 'error',
    });
    json(res, await response.json(), response.status);
  };
  return { dir, worker, config, task, state, complete, forward };
}

test('a redirected backup check cannot become an authenticated cancellation', async t => {
  const f = await workerFixture(t), before = readFileSync(join(f.dir, 'state.json')), paths = [];
  const proxy = await server(t, async (req, res, bytes) => {
    paths.push(req.url);
    if (req.url === '/checked') { res.writeHead(307, { location: '/cancel' }); res.end(); return; }
    await f.forward(req, res, bytes);
  });
  await assert.rejects(request('checked', { id: 'owned' }, { ...f.config, controlPort: proxy.port }), redirectFailure);
  assert.deepEqual(paths, ['/checked']);
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  assert.equal(f.state().status, 'running'); assert.equal(f.state().token, f.task.token);
});

for (const resume of [false, true]) test(`collection${resume ? ' resume' : ''} refuses a redirected ack without claiming collection or retiring access`, async t => {
  const f = await workerFixture(t); await f.complete();
  const before = readFileSync(join(f.dir, 'state.json')), paths = [];
  const proxy = await server(t, async (req, res, bytes) => {
    paths.push(req.url);
    if (req.url === '/ack') {
      // A 303 would turn POST ack into a successful GET tasks; a 307 would
      // turn it into POST cancel, deliberately discarding the result instead.
      res.writeHead(resume ? 307 : 303, { location: resume ? '/cancel' : '/tasks' }); res.end(); return;
    }
    await f.forward(req, res, bytes);
  });
  await assert.rejects(collectTask('owned', { ...f.config, controlPort: proxy.port }, { resume }), redirectFailure);
  assert.deepEqual(paths, [...(resume ? ['/reconcile'] : ['/wait?id=owned', '/reconcile']), '/ack']);
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
  assert.equal(f.state().collected, false); assert.equal(f.state().token, f.task.token);
  assert.equal(readFileSync(join(f.dir, 'owned.result.txt'), 'utf8'), resultBytes);
  // A later explicit call through the real controller still performs normal collection.
  assert.equal((await collectTask('owned', f.config, { resume })).collected, true);
});

test('a redirect after a committed ack still requires explicit reconciliation, not rollback or replay', async t => {
  const f = await workerFixture(t); await f.complete();
  let acks = 0, targets = 0;
  const proxy = await server(t, async (req, res, bytes) => {
    if (req.url === '/ack') {
      acks++; await request('ack', JSON.parse(bytes), f.config);
      res.writeHead(303, { location: '/target' }); res.end(); return;
    }
    if (req.url === '/target') { targets++; json(res, { ok: true }); return; }
    await f.forward(req, res, bytes);
  });
  await assert.rejects(collectTask('owned', { ...f.config, controlPort: proxy.port }), redirectFailure);
  assert.equal(acks, 1); assert.equal(targets, 0);
  assert.equal(f.state().collected, true); assert.equal(f.state().token, undefined);
  const result = await collectTask('owned', f.config, { resume: true });
  assert.equal(result.disposition, 'already_collected'); assert.equal(result.integrity, 'verified');
  assert.equal(readFileSync(join(f.dir, 'owned.result.txt'), 'utf8'), resultBytes);
});

test('the ordinary CLI rejects redirects without printing body or Location data', async t => {
  const dir = directory(t), key = 'fixture-key-' + privateText;
  writeFileSync(join(dir, 'controller.key'), key);
  let visits = 0;
  const controller = await server(t, (req, res) => {
    if (req.url === '/register') {
      res.writeHead(308, { location: '/target?' + privateText }); res.end(privateText); return;
    }
    visits++; json(res, { ok: true });
  });
  const file = join(dir, 'config.json'), input = join(dir, 'input.json');
  writeFileSync(file, JSON.stringify({ dataDir: dir, controlPort: controller.port, mcpPort: 1 }));
  writeFileSync(input, JSON.stringify(payload));
  await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), 'register', input], {
    env: { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir }, windowsHide: true, timeout: 10000,
  }), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, '');
    assert.match(error.stderr, /^WebGPT: /);
    assert.ok(!error.stderr.includes(privateText)); assert.ok(!error.stderr.includes(dir));
    return true;
  });
  assert.equal(visits, 0);
});

test('direct JSON responses and existing HTTP error classification are unchanged', async t => {
  const dir = directory(t); writeFileSync(join(dir, 'controller.key'), 'fixture-only-key');
  const controller = await server(t, (req, res) => {
    if (req.url === '/ready') json(res, { error: 'worker is stopping', code: 'SHUTTING_DOWN', retryable: true }, 503);
    else if (req.url === '/cancel') json(res, { error: 'unknown task', retryable: false }, 400);
    else json(res, { ok: true });
  });
  const config = { dataDir: dir, controlPort: controller.port };
  assert.deepEqual(await request('status', undefined, config), { ok: true });
  assert.deepEqual(await request('checked', { id: 'owned' }, config), { ok: true });
  await assert.rejects(request('ready', undefined, config), error => error.statusCode === 503 && retryableControllerError(error));
  await assert.rejects(request('cancel', { id: 'unknown' }, config), error => error.statusCode === 400 && !retryableControllerError(error));
});
