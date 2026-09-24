// Keep the launch spelling as well as the native module identity. Node resolves
// directory aliases before import.meta.url, losing a sibling deployment tree.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fault } from './runtime.mjs';

export function validatedEntryPath(moduleUrl, entryPath = fileURLToPath(moduleUrl)) {
  try {
    if (typeof entryPath !== 'string' || !isAbsolute(entryPath)
        || relative(realpathSync.native(entryPath), realpathSync.native(fileURLToPath(moduleUrl))) !== '')
      throw Error();
    return resolve(entryPath);
  } catch {
    throw fault('CONFIG_INVALID', 'entryPath must identify the running installed module');
  }
}
