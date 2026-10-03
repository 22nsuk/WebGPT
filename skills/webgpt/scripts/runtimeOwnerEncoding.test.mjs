// Lock recovery and release must not turn malformed wire bytes into owner data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { acquireRuntimeLock } from './runtime.mjs';

function fixture(t, name) {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-owner-encoding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lock = join(dir, name + '.lock');
  return { dir, lock, file: join(lock, 'owner.json'), name };
}
// A JSON string containing these bytes becomes syntactically valid under lossy
// Buffer decoding. The extension leaves the ownership fields otherwise intact.
function withRawNote(owner, raw) {
  const prefix = JSON.stringify(owner).slice(0, -1) + ',"note":"';
  return Buffer.concat([Buffer.from(prefix), raw, Buffer.from('"}')]);
}
const malformed = [
  ['invalid byte', Buffer.from([0xff])],
  ['lone continuation', Buffer.from([0x80])],
  ['truncated sequence', Buffer.from([0xe2, 0x82])],
  ['encoded surrogate', Buffer.from([0xed, 0xa0, 0x80])],
];
for (const name of ['worker', 'service']) {
  for (const [label, raw] of malformed) {
    test(`${name} refuses recovery of owner metadata with ${label} before probing`, t => {
      const f = fixture(t, name);
      mkdirSync(f.lock);
      const bytes = withRawNote({ pid: process.pid, host: hostname(), instanceId: 'retained' }, raw);
      writeFileSync(f.file, bytes);
      let probes = 0, acquired;
      try {
        assert.throws(() => {
          acquired = acquireRuntimeLock(f.dir, { name, probe() { probes++; return 'dead'; } });
        }, { code: 'LOCK_UNCERTAIN', retryable: false,
          message: 'runtime lock owner is unreadable; preserve it for inspection' });
        assert.equal(probes, 0);
        assert.deepEqual(readFileSync(f.file), bytes);
        assert.deepEqual(readdirSync(f.dir), [name + '.lock']);
      } finally { acquired?.release(); }
    });

    test(`${name} refuses release of owner metadata with ${label} and permits explicit repair`, t => {
      const f = fixture(t, name), owner = acquireRuntimeLock(f.dir, { name });
      const original = readFileSync(f.file), bytes = withRawNote(JSON.parse(original), raw);
      writeFileSync(f.file, bytes);
      assert.throws(() => owner.release(), { code: 'LOCK_UNCERTAIN', retryable: false,
          message: 'runtime lock owner is unreadable; preserve it for inspection' });
      assert.deepEqual(readFileSync(f.file), bytes);
      assert.deepEqual(readdirSync(f.dir), [name + '.lock']);
      // A failed release must not mark the owner as released. Only this fixture
      // restores its saved metadata; production never repairs it automatically.
      writeFileSync(f.file, original);
      owner.release(); owner.release();
      assert.equal(existsSync(f.lock), false);
    });
  }
}

for (const name of ['worker', 'service']) {
  const host = '호스트-�-🧪';
  const serviceControl = name === 'service' ? { version: 1, port: 43139, key: 'a'.repeat(64), runtime: 'b'.repeat(64) } : undefined;
  test(`${name} retains valid Unicode, owner probes and exact dead-owner archival`, t => {
    const f = fixture(t, name);
    mkdirSync(f.lock);
    const previous = { pid: process.pid, host, instanceId: 'legacy',
      note: '\uFEFF한글 � e\u0301 🧪', escapedLegacy: '\ud800', ...(serviceControl ? { serviceControl } : {}) };
    const bytes = Buffer.from(JSON.stringify(previous, null, 2) + '\n');
    writeFileSync(f.file, bytes);
    for (const [state, code] of [['alive', 'LOCK_HELD'], ['unknown', 'LOCK_UNCERTAIN']]) {
      let probes = 0;
      assert.throws(() => acquireRuntimeLock(f.dir, { name, host, probe(pid) {
        assert.equal(pid, previous.pid); probes++; return state;
      } }), { code, retryable: false });
      assert.equal(probes, 1);
      assert.deepEqual(readFileSync(f.file), bytes);
      assert.deepEqual(readdirSync(f.dir), [name + '.lock']);
    }
    let probes = 0;
    const recovered = acquireRuntimeLock(f.dir, { name, host, serviceControl, probe(pid) {
      assert.equal(pid, previous.pid); probes++; return 'dead';
    } });
    try {
      assert.equal(probes, 1);
      const archives = readdirSync(f.dir).filter(entry => entry.startsWith(name + '.lock.stale-'));
      assert.equal(archives.length, 1);
      assert.deepEqual(readFileSync(join(f.dir, archives[0], 'owner.json')), bytes);
      const current = JSON.parse(readFileSync(f.file, 'utf8'));
      assert.equal(current.instanceId, recovered.instanceId);
      assert.notEqual(current.instanceId, previous.instanceId);
      assert.equal(current.host, host);
      assert.deepEqual(current.serviceControl, serviceControl);
    } finally { recovered.release(); }
  });

  test(`${name} releases valid Unicode extension metadata without requiring identical formatting`, t => {
    const f = fixture(t, name), owner = acquireRuntimeLock(f.dir, { name, host, serviceControl });
    const value = JSON.parse(readFileSync(f.file, 'utf8'));
    writeFileSync(f.file, JSON.stringify({ note: '\uFEFF한글 � e\u0301 🧪', ...value }, null, 2) + '\n');
    owner.release(); owner.release();
    assert.equal(existsSync(f.lock), false);
  });

  test(`${name} preserves leading-BOM and invalid-JSON refusal on recovery and release`, t => {
    const f = fixture(t, name), owner = acquireRuntimeLock(f.dir, { name });
    const original = readFileSync(f.file);
    const candidates = [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
      Buffer.alloc(0), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{"pid":')];
    for (const bytes of candidates) {
      writeFileSync(f.file, bytes);
      let probes = 0, acquired;
      try {
        assert.throws(() => {
          acquired = acquireRuntimeLock(f.dir, { name, probe() { probes++; return 'dead'; } });
        }, { code: 'LOCK_UNCERTAIN', retryable: false });
        assert.equal(probes, 0);
        assert.throws(() => owner.release(), { code: 'LOCK_UNCERTAIN', retryable: false });
        assert.deepEqual(readFileSync(f.file), bytes);
        assert.deepEqual(readdirSync(f.dir), [name + '.lock']);
      } finally { acquired?.release(); }
    }
    writeFileSync(f.file, original);
    owner.release();
    assert.equal(existsSync(f.lock), false);
  });
}
