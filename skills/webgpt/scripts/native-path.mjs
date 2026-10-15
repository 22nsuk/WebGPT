import { isUtf8 } from 'node:buffer';
import { realpathSync } from 'node:fs';

// Validate native bytes before a decoded path can select a different directory.
// This preserves ordinary aliases and literal U+FFFD, without normalizing names.
export function nativeUtf8Path(path, invalid) {
  const bytes = realpathSync.native(path, { encoding: 'buffer' });
  if (!isUtf8(bytes)) throw invalid();
  return bytes.toString('utf8');
}
