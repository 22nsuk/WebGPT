// Read at most `ceiling` bytes from an already validated, caller-owned descriptor.
// Size checks alone cannot bound a file that grows after stat. Callers request
// limit + 1 and reject the sentinel; this helper never certifies a truncated file.
import { constants } from 'node:buffer';
import { closeSync, constants as flags, fstatSync, lstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

export function readBytesUpTo(fd, ceiling) {
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > constants.MAX_LENGTH)
    throw RangeError('invalid byte read ceiling');
  const chunks = [];
  let total = 0, capacity = 4096, ended = false;
  while (total < ceiling && !ended) {
    // Grow small allocations gradually; do not reserve a whole 32 MiB diagnostic
    // allowance for an ordinary small state file. Short reads refill this chunk.
    const buffer = Buffer.allocUnsafe(Math.min(capacity, ceiling - total));
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) { ended = true; break; }
      used += count;
    }
    if (used) { chunks.push(buffer.subarray(0, used)); total += used; }
    capacity = Math.min(capacity * 2, 64 * 1024);
  }
  // Expose only initialized bytes, including after short reads or concurrent shrink.
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
}

// Keep explicit allowances mandatory for bounded callers. The uncapped state
// inventory shares file validation, not a marker/result/diagnostic byte quota.
export function readBoundedFile(file, limit, invalid, { allowLinks = false } = {}) {
  if (typeof allowLinks !== 'boolean') throw TypeError('invalid file link policy');
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= constants.MAX_LENGTH)
    throw RangeError('invalid file read limit');
  return readRegularFile(file, limit, invalid, allowLinks);
}

export function readUnboundedFile(file, invalid) {
  return readRegularFile(file, null, invalid);
}

// One owner for regular-file materialization. null limit is private to the
// explicitly unbounded wrapper; public bounded reads still reject null limits.
// Domain callers own authorization, decoding, hashes and error policy. Only
// initial ENOENT means absence. BigIntStats keeps full-width identity exact;
// descriptor validation does not provide an atomic filesystem snapshot.
function readRegularFile(file, limit, invalid, allowLinks = false) {
  if (typeof invalid !== 'function') throw TypeError('file rejection factory required');
  const regular = info => {
    if (!info.isFile() || (!allowLinks && (info.isSymbolicLink() || info.nlink !== 1n))
        || (limit !== null && info.size > limit))
      throw invalid('metadata');
  };
  // User-selected configuration can follow links without weakening the default
  // private-file policy. Compare the resolved target with the opened descriptor.
  let before;
  try { before = (allowLinks ? statSync : lstatSync)(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  regular(before);
  // A regular path can become a FIFO after the initial stat. Do not wait for a writer
  // before fstat can reject it; this is not a general filesystem I/O deadline.
  const fd = openSync(file, flags.O_RDONLY | (allowLinks ? 0 : flags.O_NOFOLLOW) | (flags.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    regular(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw invalid('identity');
    const bytes = limit === null ? readFileSync(fd) : readBytesUpTo(fd, limit + 1);
    if (limit !== null && bytes.length > limit) throw invalid('overflow');
    return { bytes, stat };
  } finally { closeSync(fd); }
}
