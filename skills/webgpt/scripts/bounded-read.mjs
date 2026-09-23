// Read at most `ceiling` bytes from an already validated, caller-owned descriptor.
// Size checks alone cannot bound a file that grows after stat. Callers request
// limit + 1 and reject the sentinel; this helper never certifies a truncated file.
import { constants } from 'node:buffer';
import { readSync } from 'node:fs';

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
