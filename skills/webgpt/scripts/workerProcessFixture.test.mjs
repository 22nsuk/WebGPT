import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readyFixture } from './test-fixtures/worker-process.mjs';

async function controller(handler, run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'webgpt-ready-fixture-'));
  writeFileSync(join(dataDir, 'controller.key'), 'fixture-key');
  let calls = 0;
  const server = createServer((req, res) => { calls++; handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ dataDir, controlPort: server.address().port }, () => calls); }
  finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
}
const options = { timeoutMs: 4000, label: 'fixture readiness', listening: () => true };

test('ready fixture waits for one authenticated response beyond the former 250ms sub-timeout', () => controller((req, res) => {
  assert.equal(req.url, '/ready');
  assert.equal(req.headers.authorization, 'Bearer fixture-key');
  setTimeout(() => res.end(JSON.stringify({ ok: true })), 350);
}, async (config, calls) => {
  assert.equal((await readyFixture(config, options)).ok, true);
  assert.equal(calls(), 1);
}));

test('ready fixture preserves a storage rejection without repeating the probe', () => controller((_req, res) => {
  res.writeHead(503);
  res.end(JSON.stringify({ ok: false, issues: ['STORAGE_UNAVAILABLE'], storage: { ok: false, code: 'EPERM' } }));
}, async (config, calls) => {
  await assert.rejects(readyFixture(config, options), error => {
    assert.match(error.message, /STORAGE_UNAVAILABLE/);
    assert.match(error.message, /EPERM/);
    assert.equal(error.cause.statusCode, 503); return true;
  });
  assert.equal(calls(), 1);
}));

test('ready fixture rejects a negative successful HTTP response', () => controller((_req, res) => {
  res.end(JSON.stringify({ ok: false }));
}, async (config, calls) => {
  await assert.rejects(readyFixture(config, options), /controller readiness failed/);
  assert.equal(calls(), 1);
}));

test('ready fixture does not reset the budget after listening consumes the deadline', () => controller((_req, res) => {
  res.end(JSON.stringify({ ok: true }));
}, async (config, calls) => {
  await assert.rejects(readyFixture(config, { ...options, timeoutMs: 40,
    listening: async () => { await delay(70); return true; },
  }), /fixture deadline/);
  assert.equal(calls(), 0);
}));

test('ready fixture times out one nonresponsive request without retrying', () => controller(() => {}, async (config, calls) => {
  await assert.rejects(readyFixture(config, { ...options, timeoutMs: 2000 }), error => {
    assert.match(error.message, /controller readiness failed/);
    assert.equal(error.cause.name, 'TimeoutError'); return true;
  });
  assert.equal(calls(), 1);
}));
