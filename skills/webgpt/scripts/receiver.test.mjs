import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReceiver } from './receiver.mjs';

async function fixture(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-receiver-test-'));
  const journal = join(dir, 'events.jsonl');
  const r = await createReceiver({ journal, ...options });
  try { await run(r, journal); } finally { await r.close(); rmSync(dir, { recursive: true }); }
}
const send = (task, extra = {}) => fetch(task.callback, { method: 'POST', body: JSON.stringify({ taskId: task.taskId, status: 'completed', summary: 'ok', ...extra }) });

test('actual HTTP callback resolves pending wait and persists before ack', () => fixture(async (r, journal) => {
  const a = r.register('a'); const waiting = r.wait(1000);
  assert.equal((await send(a)).status, 200);
  const result = await waiting;
  assert.equal(result.events[0].taskId, 'a');
  assert.match(readFileSync(journal, 'utf8'), /completion/);
  assert.equal((await r.wait(1)).events.length, 1);
  r.ack('a'); assert.equal((await r.wait(1)).events.length, 0);
}));
test('parallel early completions and duplicates do not lose or repeat tasks', () => fixture(async r => {
  const a = r.register('a'), b = r.register('b');
  await Promise.all([send(a), send(b, { status: 'failed' })]);
  assert.equal((await (await send(a)).json()).duplicate, true);
  assert.deepEqual((await r.wait()).events.map(e => e.taskId).sort(), ['a', 'b']);
  r.ack('a'); r.ack('b');
}));
test('reject wrong task, malformed and oversized payloads', () => fixture(async r => {
  const a = r.register('a');
  assert.equal((await send(a, { taskId: 'b' })).status, 400);
  assert.equal((await send(a, { status: 'running' })).status, 400);
  assert.equal((await fetch(a.callback, { method: 'POST', body: '{' })).status, 400);
  assert.equal((await fetch(a.callback, { method: 'POST', body: 'x'.repeat(9000) })).status, 413);
  assert.equal((await fetch(a.callback + '-wrong', { method: 'POST' })).status, 404);
  assert.equal((await r.wait(1)).events.length, 0);
}));
test('backup deadline returns only unfinished tasks; checks reset it', () => fixture(async r => {
  const a = r.register('a'); r.register('b');
  await send(a); r.ack('a');
  assert.deepEqual((await r.wait(1000)).backupDue, ['b']);
  r.checked('b'); assert.deepEqual((await r.wait(1)).backupDue, []);
  r.finish('b'); assert.deepEqual((await r.wait(30)).backupDue, []);
}, { backupMs: 40 }));
test('close releases pending waits and duplicate registration fails', () => fixture(async r => {
  r.register('a'); assert.throws(() => r.register('a'));
  const waiting = r.wait(1000); await r.close();
  assert.equal((await waiting).closed, true);
  assert.throws(() => r.register('b'));
}));
