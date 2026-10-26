import { validateHeaderValue } from 'node:http';
import { fault } from './runtime.mjs';

// Share the worker's key grammar with callers before fetch can trim whitespace
// or include the credential in a native header error. Never retain that cause.
export function validateControllerKey(key) {
  try {
    if (!key || /[ \t]$/.test(key)) throw Error();
    validateHeaderValue('authorization', 'Bearer ' + key);
  } catch { throw fault('CONFIG_INVALID', 'invalid controller.key'); }
  return key;
}
