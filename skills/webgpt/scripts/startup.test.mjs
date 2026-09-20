import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { request } from './client.mjs';

for (const [name, key] of [
  ['empty', ''],
  ['trailing space', 'fixture-only '],
  ['trailing tab', 'fixture-only\t'],
  ['newline', 'fixture-only\n'],
  ['control character', 'fixture-\0-only'],
  ['DEL character', 'fixture-\x7f-only'],
  ['wide Unicode', 'fixture-한글'],
]) {
  test(`startup rejects a ${name} controller key without changing evidence and allows corrected retry`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webgpt-startup-invalid-key-'));
    const keyPath = join(dir, 'controller.key');
    const statePath = join(dir, 'state.json');
    const state = '[\n]\n';
    let service;
    try {
      writeFileSync(keyPath, key);
      writeFileSync(statePath, state);
      await assert.rejects(async () => {
        service = await start({ dir, port: 0, controlPort: 0 });
      }, { message: 'invalid controller.key' });
      assert.equal(readFileSync(keyPath, 'utf8'), key);
      assert.equal(readFileSync(statePath, 'utf8'), state);
      assert.equal(existsSync(join(dir, 'worker.lock')), false);

      // The owner can repair its preserved key and retry without recovering a stale lock.
      writeFileSync(keyPath, 'corrected-fixture-only-key');
      service = await start({ dir, port: 0, controlPort: 0 });
      assert.deepEqual(await request('status', undefined, {
        dataDir: dir, controlPort: service.controlPort,
      }), { events: [], backupDue: [] });
      assert.equal(readFileSync(statePath, 'utf8'), state);
    } finally {
      // Also close an unexpectedly successful pre-fix startup after assert.rejects fails.
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const [name, key] of [
  ['custom ASCII', 'fixture-only-custom-key'],
  ['leading space', ' fixture-only'],
  ['internal space', 'fixture only'],
  ['Latin-1', 'fixture-é'],
]) {
  test(`startup preserves a header-compatible ${name} controller key`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webgpt-startup-valid-key-'));
    const keyPath = join(dir, 'controller.key');
    let service;
    try {
      writeFileSync(keyPath, key);
      service = await start({ dir, port: 0, controlPort: 0 });
      assert.deepEqual(await request('status', undefined, {
        dataDir: dir, controlPort: service.controlPort,
      }), { events: [], backupDue: [] });
      assert.equal(readFileSync(keyPath, 'utf8'), key);
    } finally {
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
