import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { request } from './client.mjs';
import { start } from './worker.mjs';

const execute = promisify(execFile), cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-task-id-cli-')), requests = [];
  const file = join(dir, 'config.json');
  let worker, observer, clock = 1000;
  t.after(async () => {
    observer?.mock.restore();
    await worker?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: file,
    now: () => clock, waitMs: 20, closeGraceMs: 50 });
  const emit = Server.prototype.emit;
  observer = t.mock.method(Server.prototype, 'emit', function(event, ...args) {
    const result = Reflect.apply(emit, this, [event, ...args]);
    if (event === 'request' && this.address()?.port === worker.controlPort) {
      const url = new URL(args[0].url, 'http://localhost');
      const req = args[0], entry = { method: req.method, path: url.pathname, ids: url.searchParams.getAll('id') };
      requests.push(entry);
      if (req.method === 'POST' && ['/wait', '/reconcile'].includes(url.pathname)) {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.once('end', () => { entry.ids = JSON.parse(Buffer.concat(chunks).toString('utf8')).ids; });
      }
    }
    return result;
  });
  const config = { dataDir: dir, controlPort: worker.controlPort, mcpPort: worker.mcpPort };
  writeFileSync(file, JSON.stringify(config));
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  const admin = (action, payload) => request(action, payload, config);
  return {
    dir, requests, advance: () => { clock += 1000; },
    register: id => admin('register', { id, instructions: 'fixture only', inputs: {} }),
    task: async id => (await admin('reconcile', { ids: [id] })).tasks[0],
    async complete(id, token) {
      const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'submit_result', arguments: { token, status: 'completed',
            summary: 'fixture', result: `result for ${id}\n` } } }),
      });
      const body = await response.json();
      assert.equal(response.status, 200); assert.equal(body.error, undefined);
      assert.ok(body.result && !body.result.isError);
    },
    async run(...args) {
      const { stdout, stderr } = await execute(process.execPath, [cli, ...args], {
        cwd: dir, env, timeout: 15000, windowsHide: true,
      });
      assert.equal(stderr, '');
      return JSON.parse(stdout);
    },
  };
}

for (const action of ['ack', 'checked', 'cancel']) {
  test(`${action} selects literal IDs without redirecting to same-named files and retains legacy inputs`, async t => {
    const f = await fixture(t);
    await f.register('decoy');
    const decoy = await f.task('decoy');
    const cases = [
      ...['--file', '--resume', '--'].map(id => ({ id, args: ['--', id] })),
      { id: 'plain', args: ['plain'] },
      { id: 'explicit-file', args: ['--file', 'payload'] },
      { id: 'legacy-file', args: ['./payload'] },
    ];
    for (const { id, args } of cases) {
      const registered = await f.register(id), bytes = '{"id":"decoy"}';
      writeFileSync(join(f.dir, id), bytes);
      writeFileSync(join(f.dir, 'payload'), JSON.stringify({ id }));
      if (action === 'ack') await f.complete(id, registered.token);
      const before = await f.task(id);
      f.advance();
      await f.run(action, ...args);
      const after = await f.task(id);
      if (action === 'checked') {
        assert.equal(after.status, 'running'); assert.equal(after.collected, false);
        assert.equal(after.nextCheck, before.nextCheck + 1000);
      } else {
        assert.equal(after.status, action === 'ack' ? 'completed' : 'cancelled');
        assert.equal(after.collected, true);
      }
      assert.equal(readFileSync(join(f.dir, id), 'utf8'), bytes);
    }
    assert.deepEqual(await f.task('decoy'), decoy);
  });
}

for (const resume of [false, true]) {
  test(`collect ${resume ? 'resume' : 'ordinary'} mode handles literal IDs and preserves completed evidence on resume`, async t => {
    const f = await fixture(t);
    await f.register('decoy');
    const decoy = await f.task('decoy');
    for (const id of ['--resume', '--file', '--']) {
      const registered = await f.register(id);
      await f.complete(id, registered.token);
      writeFileSync(join(f.dir, id), '{"id":"decoy"}');
      const before = f.requests.length;
      const collected = await f.run('collect', ...(resume ? ['--resume'] : []), '--', id);
      assert.deepEqual(f.requests[before], { method: 'POST', path: resume ? '/reconcile' : '/wait', ids: [id] });
      assert.equal(collected.id, id); assert.equal(collected.integrity, 'verified');
      if (resume) assert.equal(collected.disposition, 'collected');
      else { assert.equal(collected.collected, true); assert.equal(Object.hasOwn(collected, 'disposition'), false); }
      const state = readFileSync(join(f.dir, 'state.json'));
      const again = await f.run('collect', '--resume', '--', id);
      assert.equal(again.id, id); assert.equal(again.disposition, 'already_collected');
      assert.equal(again.integrity, 'verified');
      assert.deepEqual(readFileSync(join(f.dir, 'state.json')), state);
      assert.equal(readFileSync(join(f.dir, `${id}.result.txt`), 'utf8'), `result for ${id}\n`);
      assert.equal(readFileSync(join(f.dir, id), 'utf8'), '{"id":"decoy"}');
    }
    assert.deepEqual(await f.task('decoy'), decoy);
  });
}

test('literal task selectors reject missing, multiple and invalid IDs before controller access', async t => {
  const f = await fixture(t);
  await f.register('decoy');
  const payload = join(f.dir, 'payload'), bytes = '{"id":"decoy"}';
  writeFileSync(payload, bytes);
  const state = readFileSync(join(f.dir, 'state.json')), before = f.requests.length;
  const cases = [
    ...['ack', 'checked', 'cancel', 'collect'].flatMap(action =>
      [[], ['./payload'], ['--file', 'payload'], ['x'.repeat(81)]].map(ids => [action, '--', ...ids])),
    ...[[], ['./payload'], ['--resume', 'decoy']].map(ids => ['collect', '--resume', '--', ...ids]),
  ];
  for (const args of cases) {
    await assert.rejects(f.run(...args), error => {
      assert.equal(error.code, 1); assert.equal(error.signal, null); assert.equal(error.killed, false);
      assert.equal(error.stdout, ''); assert.match(error.stderr, /WebGPT: /);
      return true;
    });
  }
  assert.equal(f.requests.length, before);
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), state);
  assert.equal(readFileSync(payload, 'utf8'), bytes);
});
