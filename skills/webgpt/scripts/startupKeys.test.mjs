import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { readFixture, observeFileRead } from './test-fixtures/file-read.mjs';

const keys = [
  { name: 'controller.key', value: 'fixture-only-custom-key', limit: 4096 },
  { name: 'mcp-path.key', value: 'ab'.repeat(32), limit: 64 },
];
const state = '[\n]\n';
function fixture(t) {
  const dir = join(readFixture(t), 'runtime'); fs.mkdirSync(dir);
  for (const key of keys) fs.writeFileSync(join(dir, key.name), key.value);
  fs.writeFileSync(join(dir, 'state.json'), state);
  return dir;
}

async function rejectStartup(t, dir, name, expected = { code: 'CONFIG_INVALID', message: 'invalid ' + name }) {
  let service;
  const listen = t.mock.method(Server.prototype, 'listen', Server.prototype.listen);
  try {
    await assert.rejects(async () => {
      service = await start({ dir, port: 0, controlPort: 0, publicMcp: true });
    }, expected);
    assert.equal(listen.mock.callCount(), 0, 'reject before opening either listener');
    assert.equal(fs.existsSync(join(dir, 'worker.lock')), false, 'release startup ownership');
    assert.equal(fs.existsSync(join(dir, 'state.initialized')), false);
    assert.equal(fs.readFileSync(join(dir, 'state.json'), 'utf8'), state);
  } finally {
    listen.mock.restore();
    // A pre-fix success must not leave listeners behind when assert.rejects fails.
    await service?.close();
  }
}

for (const key of keys) {
  for (const kind of ['oversized', 'directory', 'hardlink', 'symlink', 'dangling']) {
    test(`startup rejects ${kind} ${key.name} before content reads and preserves evidence`, async t => {
      const dir = fixture(t), file = join(dir, key.name), target = file + '.target';
      if (kind === 'oversized') fs.writeFileSync(file, 'a'.repeat(key.limit + 1));
      if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
      if (kind === 'hardlink') fs.linkSync(file, target);
      if (kind === 'symlink' || kind === 'dangling') {
        fs.renameSync(file, target);
        try { fs.symlinkSync(kind === 'dangling' ? target + '.missing' : target, file, 'file'); }
        catch (error) {
          if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code))
            return t.skip('native file symlink creation is unavailable');
          throw error;
        }
      }
      const before = fs.lstatSync(file, { bigint: true }), trace = observeFileRead(t, file);
      try { await rejectStartup(t, dir, key.name); } finally { trace.restore(); }
      assert.equal(trace.evidence.opens, 0); assert.equal(trace.evidence.bytes, 0);
      const after = fs.lstatSync(file, { bigint: true });
      for (const field of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs']) assert.equal(after[field], before[field]);
      if (kind === 'symlink' || kind === 'dangling') {
        assert.equal(fs.readlinkSync(file), kind === 'dangling' ? target + '.missing' : target);
        assert.equal(fs.readFileSync(target, 'utf8'), key.value);
        assert.equal(fs.existsSync(target + '.missing'), false);
      } else if (kind !== 'directory') {
        assert.equal(fs.readFileSync(file, 'utf8'), kind === 'oversized' ? 'a'.repeat(key.limit + 1) : key.value);
      }
    });
  }

  test(`startup bounds ${key.name} growth after descriptor stat`, async t => {
    const dir = fixture(t), file = join(dir, key.name), grown = 'a'.repeat(key.limit + 100);
    const trace = observeFileRead(t, file, { afterStat: () => fs.writeFileSync(file, grown) });
    try { await rejectStartup(t, dir, key.name); } finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, key.limit + 1, 'read only the limit and overflow sentinel');
    assert.equal(trace.evidence.closes, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), grown);
  });

  test(`startup rejects a replaced ${key.name} descriptor without reading either key`, async t => {
    const dir = fixture(t), file = join(dir, key.name), original = file + '.original';
    const replacement = key.name === 'controller.key' ? 'replacement-fixture-only' : 'cd'.repeat(32);
    const trace = observeFileRead(t, file, { beforeOpen() {
      fs.renameSync(file, original); fs.writeFileSync(file, replacement);
    } });
    try { await rejectStartup(t, dir, key.name); } finally { trace.restore(); }
    assert.equal(trace.evidence.bytes, 0); assert.equal(trace.evidence.closes, 1);
    assert.equal(fs.readFileSync(original, 'utf8'), key.value);
    assert.equal(fs.readFileSync(file, 'utf8'), replacement);
  });

  for (const [phase, code] of [['lstat', 'EACCES'], ['open', 'ENOENT'], ['read', 'EIO']]) {
    test(`startup preserves ${key.name} ${phase} ${code} without key regeneration`, async t => {
      const dir = fixture(t), file = join(dir, key.name);
      const failure = Object.assign(Error('injected fixture I/O failure'), { code });
      const fail = () => { throw failure; };
      let lookup;
      if (phase === 'lstat') {
        const native = fs.lstatSync;
        lookup = t.mock.method(fs, 'lstatSync', (path, ...args) => path === file ? fail() : native(path, ...args));
        syncBuiltinESMExports();
      }
      const trace = observeFileRead(t, file, {
        ...(phase === 'open' ? { beforeOpen: fail } : {}),
        ...(phase === 'read' ? { beforeRead: fail } : {}),
      });
      try { await rejectStartup(t, dir, key.name, error => error === failure); }
      finally { trace.restore(); lookup?.mock.restore(); syncBuiltinESMExports(); }
      assert.equal(fs.readFileSync(file, 'utf8'), key.value);
      assert.equal(trace.evidence.closes, phase === 'read' ? 1 : 0);
    });
  }

  test(`startup rejects a writerless ${key.name} FIFO without waiting for a writer`, {
    skip: process.platform === 'win32',
  }, t => {
    const dir = fixture(t), file = join(dir, key.name); fs.unlinkSync(file);
    const made = spawnSync('mkfifo', [file], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(made.error); assert.equal(made.status, 0, made.stderr);
    const before = fs.lstatSync(file, { bigint: true });
    // A same-process timeout cannot interrupt a synchronous FIFO open. The
    // external watchdog covers the real worker start(), not an extracted read.
    const script = `
      import assert from 'node:assert/strict';
      import { start } from ${JSON.stringify(new URL('./worker.mjs', import.meta.url).href)};
      let service;
      try {
        await assert.rejects(async () => {
          service = await start({ dir: process.argv[1], port: 0, controlPort: 0, publicMcp: true });
        }, { code: 'CONFIG_INVALID', message: 'invalid ' + process.argv[2] });
      } finally { await service?.close(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir, key.name], {
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
    });
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    const after = fs.lstatSync(file, { bigint: true });
    assert.ok(after.isFIFO()); assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev);
    assert.equal(fs.existsSync(join(dir, 'worker.lock')), false);
    assert.equal(fs.existsSync(join(dir, 'state.initialized')), false);
    assert.equal(fs.readFileSync(join(dir, 'state.json'), 'utf8'), state);
  });
}

test('startup rejects a 4 MiB printable controller key without materializing it', async t => {
  const dir = fixture(t), file = join(dir, 'controller.key'), bytes = Buffer.alloc(4 * 1024 * 1024, 97);
  fs.writeFileSync(file, bytes);
  const trace = observeFileRead(t, file);
  try { await rejectStartup(t, dir, 'controller.key'); } finally { trace.restore(); }
  assert.equal(trace.evidence.opens, 0); assert.equal(trace.evidence.bytes, 0);
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('startup accepts a 4096-byte custom controller key and preserves it across restart', async t => {
  const dir = fixture(t), file = join(dir, 'controller.key');
  // The allowance counts UTF-8 bytes, not characters or a UUID-only grammar.
  const key = 'é'.repeat(2048); fs.writeFileSync(file, key);
  const before = fs.lstatSync(file, { bigint: true });
  let service;
  try {
    for (let run = 0; run < 2; run++) {
      service = await start({ dir, port: 0, controlPort: 0, publicMcp: true });
      assert.equal(service.key, key);
      const response = await fetch(`http://127.0.0.1:${service.controlPort}/status`, {
        headers: { authorization: 'Bearer ' + key },
      });
      assert.equal(response.status, 200); await response.arrayBuffer();
      await service.close();
      const after = fs.lstatSync(file, { bigint: true });
      assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(fs.readFileSync(file, 'utf8'), key);
    }
  } finally { await service?.close(); }
});

test('local-only startup does not inspect or replace the inactive public route key', async t => {
  const dir = fixture(t), file = join(dir, 'mcp-path.key'); fs.unlinkSync(file); fs.mkdirSync(file);
  let service;
  try {
    service = await start({ dir, port: 0, controlPort: 0, publicMcp: false });
    assert.ok(fs.lstatSync(file).isDirectory());
  } finally { await service?.close(); }
});
