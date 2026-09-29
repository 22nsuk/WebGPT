// Observe native I/O, not a particular higher-level reader or fabricated result.
// Faults and races affect only one disposable file; callers restore before checking evidence.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function readFixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-read-contract-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function observeFileRead(t, file, { beforeOpen, beforeRead, chunkSize = Infinity } = {}) {
  const native = { open: fs.openSync, read: fs.readSync, whole: fs.readFileSync, close: fs.closeSync };
  const descriptors = new Set(), mocks = [];
  const evidence = { opens: 0, closes: 0, bytes: 0, reads: 0 };
  let entered = false, whole = false, injecting = false;
  const inject = fn => { injecting = true; try { fn?.(); } finally { injecting = false; } };
  const enter = () => { if (!entered) { entered = true; inject(beforeRead); } };
  mocks.push(t.mock.method(fs, 'openSync', (path, ...args) => {
    if (injecting) return native.open(path, ...args);
    if (path === file) inject(beforeOpen);
    const fd = native.open(path, ...args);
    if (path === file) { descriptors.add(fd); evidence.opens++; }
    return fd;
  }));
  mocks.push(t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    if (!descriptors.has(fd) || whole) return native.read(fd, buffer, offset, length, position);
    enter(); evidence.reads++;
    const count = native.read(fd, buffer, offset, Math.min(length, chunkSize), position);
    evidence.bytes += count;
    return count;
  }));
  // Retain a truthful pre-fix measurement for descriptor readers that still use readFileSync.
  mocks.push(t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path !== file && !descriptors.has(path)) return native.whole(path, ...args);
    enter(); evidence.reads++; whole = true;
    try {
      const result = native.whole(path, ...args);
      evidence.bytes += Buffer.isBuffer(result) ? result.length : Buffer.byteLength(result);
      return result;
    } finally { whole = false; }
  }));
  mocks.push(t.mock.method(fs, 'closeSync', fd => {
    const result = native.close(fd);
    if (descriptors.delete(fd)) evidence.closes++;
    return result;
  }));
  syncBuiltinESMExports();
  return { evidence, restore() {
    for (const mock of mocks.reverse()) mock.mock.restore();
    syncBuiltinESMExports();
  } };
}
