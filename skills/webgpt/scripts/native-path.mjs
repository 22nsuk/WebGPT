import { isUtf8 } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { isAbsolute, parse } from 'node:path';

// Windows root-only paths select the current drive. Validate before any I/O;
// resolving them would silently commit that ambient choice.
export function isFullyQualifiedPath(path) {
  return typeof path === 'string' && path.isWellFormed() && !path.includes('\0') && isAbsolute(path)
    && (process.platform !== 'win32' || parse(path).root.length > 1);
}

// Validate native bytes before a decoded path can select a different directory.
// This preserves ordinary aliases and literal U+FFFD, without normalizing names.
export function nativeUtf8Path(path, invalid) {
  const bytes = realpathSync.native(path, { encoding: 'buffer' });
  if (!isUtf8(bytes)) throw invalid();
  return bytes.toString('utf8');
}
