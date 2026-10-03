// Keep the launch spelling as well as the native module identity. Node resolves
// directory aliases before import.meta.url, losing a sibling deployment tree.
import { isUtf8 } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fault } from './runtime.mjs';

export function validatedEntryPath(moduleUrl, entryPath = fileURLToPath(moduleUrl)) {
  try {
    if (typeof entryPath !== 'string' || !entryPath.isWellFormed() || !isAbsolute(entryPath)) throw Error();
    // Compare native bytes before decoding can collapse distinct installation paths.
    const entry = realpathSync.native(entryPath, { encoding: 'buffer' });
    const module = realpathSync.native(fileURLToPath(moduleUrl), { encoding: 'buffer' });
    if (!isUtf8(entry) || !isUtf8(module) || !entry.equals(module)) throw Error();
    return resolve(entryPath);
  } catch {
    throw fault('CONFIG_INVALID', 'entryPath must identify the running installed module');
  }
}
