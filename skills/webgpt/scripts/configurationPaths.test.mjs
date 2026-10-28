import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFixture } from './test-fixtures/file-read.mjs';
import { rejectsRequest } from './test-fixtures/request-error.mjs';
import { spawnFixtureWorker } from './test-fixtures/worker-process.mjs';

const execute = promisify(execFile);
const client = fileURLToPath(new URL('./client.mjs', import.meta.url));
const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function fixture(t, source, controlPort = 43139) {
  const base = readFixture(t);
  if (!/^[A-Za-z]:\\/.test(base)) { t.skip('drive-backed temporary fixture required'); return; }
  const file = join(base, 'private-config.json'), dir = join(base, 'private-runtime');
  const config = { dataDir: dir, controlPort, mcpPort: controlPort === 43137 ? 43138 : 43137 };
  const env = { ...process.env, WEBGPT_CONFIG: file, WEBGPT_DATA_DIR: dir, WEBGPT_MCP_AUDIT: '0' };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  if (source === 'WEBGPT_CONFIG') env.WEBGPT_CONFIG = file.slice(2);
  else if (source === 'WEBGPT_DATA_DIR') env.WEBGPT_DATA_DIR = dir.slice(2);
  else { delete env.WEBGPT_DATA_DIR; config.dataDir = dir.slice(2); }
  const bytes = JSON.stringify(config); fs.writeFileSync(file, bytes);
  return { base, file, dir, env, bytes };
}

for (const source of ['WEBGPT_CONFIG', 'WEBGPT_DATA_DIR', 'saved dataDir']) {
  test(`Windows review CLI rejects drive-less ${source} without requests or evidence changes`,
    { skip: process.platform !== 'win32' }, async t => {
      let requests = 0;
      const server = createServer((_req, res) => {
        requests++; res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'FIXTURE_REQUEST_REACHED', error: 'unexpected fixture request' }));
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        const f = fixture(t, source, server.address().port); if (!f) return;
        fs.mkdirSync(f.dir);
        const evidence = [['controller.key', 'private-fixture-key'], ['state.json', '[]\n'], ['owned.result.txt', 'private fixture result']]
          .map(([name, bytes]) => { const file = join(f.dir, name); fs.writeFileSync(file, bytes); return [file, bytes]; });
        // The child runs on the fixture drive, so the old implementation would
        // read this real configuration/key and reach the counting controller.
        await rejectsRequest(execute(process.execPath, [client, 'review', 'owned'], {
          cwd: f.base, env: f.env, timeout: 10000, killSignal: 'SIGKILL', windowsHide: true,
        }), error => {
          assert.equal(error.code, 1); assert.equal(error.signal, null); assert.equal(error.killed, false);
          assert.equal(error.stdout, '');
          assert.equal(error.stderr, 'WebGPT: ' + JSON.stringify({ code: 'CONFIG_INVALID',
            message: 'WebGPT configuration or controller key is invalid; inspect the selected configuration and runtime key',
          }) + '\n');
          assert.ok(!error.stderr.includes(f.base)); assert.doesNotMatch(error.stderr, /private-fixture|private fixture/);
          return true;
        });
        assert.equal(requests, 0);
        assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
        for (const [file, bytes] of evidence) assert.equal(fs.readFileSync(file, 'utf8'), bytes);
        assert.deepEqual(fs.readdirSync(f.dir).sort(), ['controller.key', 'owned.result.txt', 'state.json']);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });

  test(`Windows worker CLI rejects drive-less ${source} before runtime creation`,
    { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
      const f = fixture(t, source); if (!f) return;
      const observed = spawnFixtureWorker(process.execPath, [worker], {
        cwd: f.base, env: f.env, windowsHide: true,
      }, () => {
        // A pre-fix run may start this disposable worker. Stop only the owned
        // child through IPC and await its exit before assertions or cleanup.
        if (observed.child.connected) observed.child.send({ type: 'shutdown' }, () => {});
      });
      const deadline = setTimeout(() => observed.child.kill('SIGKILL'), 10000);
      let outcome;
      try { outcome = await observed.exit; await observed.closed; }
      finally {
        if (observed.child.exitCode === null && observed.child.signalCode === null) observed.child.kill('SIGKILL');
        await observed.closed; clearTimeout(deadline);
      }
      assert.deepEqual(outcome, [78, null], observed.diagnostic());
      assert.equal(observed.listening, null);
      const { stdout, stderr } = JSON.parse(observed.diagnostic());
      assert.equal(stdout, '');
      assert.equal(stderr, JSON.stringify({ event: 'startup_failed', code: 'CONFIG_INVALID' }) + '\n');
      assert.equal(fs.existsSync(f.dir), false);
      assert.deepEqual(fs.readdirSync(f.base), ['private-config.json']);
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
    });
}
