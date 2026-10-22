// Test assertions only: observe an already-started request without retrying it.
import assert from 'node:assert/strict';

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit).toWellFormed() : null;
function snapshot(error, seen = new Map(), depth = 0) {
  if (error == null) return error;
  if (typeof error !== 'object') return true; // Let feedback mark an unsupported cause without copying its value.
  if (seen.has(error)) return seen.get(error);
  if (depth === 3) return {}; // Preserve the reporter's depth-omission signal without reading another error.
  const code = error.code;
  // One extra code unit lets test-feedback own final clipping and its truncated flag.
  // Plain fields also survive Node's child-process serialization of DOMException.
  const copy = { name: text(error.name, 65),
    code: text(typeof code === 'number' && Number.isFinite(code) ? String(code) : code, 129),
    message: text(error.message, 257) };
  seen.set(error, copy);
  const cause = error.cause;
  if (cause != null) copy.cause = snapshot(cause, seen, depth + 1);
  return copy;
}

export async function rejectsRequest(promise, expected, message) {
  let rejected = false, original;
  try {
    await assert.rejects(promise.catch(error => {
      rejected = true; original = error; throw error;
    }), expected, message);
  } catch (failure) {
    // Keep the same matcher failure, including errors thrown by the validator.
    // Diagnostic enrichment must not replace a frozen failure or unreadable reason.
    try {
      if (failure instanceof Error && rejected && failure !== original && !Object.hasOwn(failure, 'cause')) {
        Object.defineProperty(failure, 'cause', { value: snapshot(original), configurable: true, writable: true });
      }
    } catch { /* The native failure below remains authoritative. */ }
    throw failure;
  }
}
