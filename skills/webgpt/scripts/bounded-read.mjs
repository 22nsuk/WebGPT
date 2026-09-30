// Read at most `ceiling` bytes from an already validated, caller-owned descriptor.
// Size checks alone cannot bound a file that grows after stat. Callers request
// limit + 1 and reject the sentinel; this helper never certifies a truncated file.
import { constants } from 'node:buffer';
import { closeSync, constants as flags, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

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

// One owner for materializing bounded file reads. Domain callers still own path
// authorization, decoding, hashes and error policy. null means only initial
// ENOENT; an error after observing a file never becomes successful absence.
// Keep full-width device/inode values: Number can alias distinct 64-bit identities.
// The returned stat is BigIntStats; the descriptor is not an atomic snapshot.
export function readBoundedFile(file, limit, invalid) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= constants.MAX_LENGTH)
    throw RangeError('invalid file read limit');
  if (typeof invalid !== 'function') throw TypeError('file rejection factory required');
  const regular = info => {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > limit)
      throw invalid('metadata');
  };
  let before;
  try { before = lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  regular(before);
  // A regular path can become a FIFO after lstat. Do not wait for a writer
  // before fstat can reject it; this is not a general filesystem I/O deadline.
  const fd = openSync(file, flags.O_RDONLY | flags.O_NOFOLLOW | (flags.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    regular(stat);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw invalid('identity');
    const bytes = readBytesUpTo(fd, limit + 1);
    if (bytes.length > limit) throw invalid('overflow');
    return { bytes, stat };
  } finally { closeSync(fd); }
}
