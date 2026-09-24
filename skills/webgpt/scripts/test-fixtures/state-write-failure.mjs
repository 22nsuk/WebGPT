// Inject at the state writer, not by pre-creating an obstruction before the edit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

export async function withStateWriteFailure(t, dir, run) {
  const stage = join(dir, 'state.json.tmp'), open = fs.openSync;
  assert.equal(fs.existsSync(stage), false);
  let reached = false;
  const mock = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === stage) {
      reached = true;
      throw Object.assign(Error('fixture state write failure'), { code: 'EIO' });
    }
    return open(file, ...args);
  });
  syncBuiltinESMExports();
  let result;
  try { result = await run(); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(reached, true, 'the operation reached the real state writer');
  return result;
}
