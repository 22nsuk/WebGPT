import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { changeWorkspace, grantWorkspace, inspectRecovery, readWorkspace } from './workspace.mjs';

const original = 'before\n', replacement = 'AFTER\n', outsider = 'OTHER\n';
const changed = /replacement staging file changed/;
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'webgpt-stage-'));
  const project = join(root, 'project'), runtime = join(root, 'runtime'), file = join(project, 'note.txt');
  fs.mkdirSync(project); fs.mkdirSync(runtime); fs.writeFileSync(file, original);
  const grant = grantWorkspace({ root: project, mode: 'edit' });
  const expectedSha256 = readWorkspace(grant, 'note.txt').sha256;
  const state = { root, project, runtime, file, stage: null, displaced: join(root, 'displaced.tmp'),
    edit: (options = {}) => changeWorkspace(grant, runtime, 'stage-test',
      { path: 'note.txt', expectedSha256, text: replacement, ...options }) };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return state;
}
// Keep real descriptors, writes, rename/link operations and recovery files. Only
// the interleaving/failure is injected; no sleep or fake filesystem identities.
function interceptStage(t, f, { afterClose = () => {}, beforeWrite, beforeFlush } = {}) {
  const open = fs.openSync, close = fs.closeSync, write = fs.writeFileSync, flush = fs.fsyncSync;
  const descriptors = new Set(); let closed = 0;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = open(...args);
    if (f.stage === null && typeof args[0] === 'string' && /^\.webgpt-.*\.tmp$/.test(basename(args[0]))) {
      f.stage = args[0]; descriptors.add(fd);
    }
    return fd;
  });
  t.mock.method(fs, 'closeSync', fd => {
    const selected = descriptors.delete(fd);
    close(fd);
    if (selected) { closed++; afterClose(f.stage); }
  });
  if (beforeWrite) t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (descriptors.has(file)) beforeWrite(file, args, write);
    return write(file, ...args);
  });
  if (beforeFlush) t.mock.method(fs, 'fsyncSync', fd => {
    if (descriptors.has(fd)) beforeFlush(fd, flush);
    return flush(fd);
  });
  syncBuiltinESMExports();
  return () => { assert.ok(f.stage, 'the replacement descriptor was exercised'); assert.equal(closed, 1); };
}
function swap(f, bytes = outsider) {
  fs.renameSync(f.stage, f.displaced);
  fs.writeFileSync(f.stage, bytes, { flag: 'wx' });
  const a = fs.lstatSync(f.stage, { bigint: true }), b = fs.lstatSync(f.displaced, { bigint: true });
  assert.ok(a.dev !== b.dev || a.ino !== b.ino, 'the replacement has a distinct native identity');
}
function prepared(f, expectedOriginal = original) {
  assert.equal(fs.readFileSync(f.file, 'utf8'), expectedOriginal);
  const directory = join(f.runtime, 'recovery', 'stage-test');
  const names = fs.readdirSync(directory), journals = names.filter(name => name.endsWith('.json'));
  assert.equal(journals.length, 1); assert.equal(names.length, 2);
  const journal = join(directory, journals[0]), saved = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.equal(saved.state, 'prepared'); assert.equal(fs.readFileSync(saved.backup, 'utf8'), original);
  assert.deepEqual(inspectRecovery(f.runtime, 'stage-test'), { receipts: [], unresolved: [journal] });
}
for (const [label, bytes] of [['different same-size bytes', outsider], ['identical bytes', replacement]]) {
  test(`replacement refuses a substituted stage with ${label} and preserves both files`, t => {
    const f = fixture(t), exercised = interceptStage(t, f, { afterClose: () => swap(f, bytes) });
    assert.throws(() => f.edit(), changed); exercised(); prepared(f);
    assert.equal(fs.readFileSync(f.stage, 'utf8'), bytes);
    assert.equal(fs.readFileSync(f.displaced, 'utf8'), replacement);
  });
}
test('replacement refuses an in-place size change and preserves the changed stage', t => {
  const f = fixture(t), exercised = interceptStage(t, f, { afterClose: stage => fs.appendFileSync(stage, 'extra') });
  assert.throws(() => f.edit(), changed); exercised(); prepared(f);
  assert.equal(fs.readFileSync(f.stage, 'utf8'), replacement + 'extra');
});
test('replacement refuses a newly hard-linked stage without consuming either link', t => {
  const f = fixture(t), alias = join(f.root, 'alias.tmp');
  const exercised = interceptStage(t, f, { afterClose: stage => fs.linkSync(stage, alias) });
  assert.throws(() => f.edit(), changed); exercised(); prepared(f);
  assert.equal(fs.lstatSync(f.stage).nlink, 2);
  assert.equal(fs.readFileSync(f.stage, 'utf8'), replacement);
  assert.equal(fs.readFileSync(alias, 'utf8'), replacement);
});
test('replacement refuses a missing stage without recreating it', t => {
  const f = fixture(t), exercised = interceptStage(t, f, { afterClose: stage => fs.renameSync(stage, f.displaced) });
  assert.throws(() => f.edit(), changed); exercised(); prepared(f);
  assert.equal(fs.existsSync(f.stage), false); assert.equal(fs.readFileSync(f.displaced, 'utf8'), replacement);
});
test('replacement refuses a directory substituted for the stage and retains its contents', t => {
  const f = fixture(t), exercised = interceptStage(t, f, { afterClose: stage => {
    fs.renameSync(stage, f.displaced); fs.mkdirSync(stage); fs.writeFileSync(join(stage, 'evidence.txt'), outsider);
  } });
  assert.throws(() => f.edit(), changed); exercised(); prepared(f);
  assert.equal(fs.readFileSync(join(f.stage, 'evidence.txt'), 'utf8'), outsider);
  assert.equal(fs.readFileSync(f.displaced, 'utf8'), replacement);
});
for (const [label, bytes] of [['different', outsider], ['identical', replacement]]) {
  test(`flush failure preserves a substituted stage with ${label} bytes and the original error`, t => {
    const f = fixture(t), failure = Object.assign(Error('injected flush failure'), { code: 'EIO' });
    const exercised = interceptStage(t, f, { beforeFlush: (fd, flush) => { flush(fd); throw failure; },
      afterClose: () => swap(f, bytes) });
    assert.throws(() => f.edit(), error => error === failure); exercised(); prepared(f);
    assert.equal(fs.readFileSync(f.stage, 'utf8'), bytes);
    assert.equal(fs.readFileSync(f.displaced, 'utf8'), replacement);
  });
}
test('source revision conflict does not delete a substituted stage or restore external source bytes', t => {
  const f = fixture(t), exercised = interceptStage(t, f, { afterClose: () => {
    swap(f); fs.writeFileSync(f.file, 'external source\n');
  } });
  assert.throws(() => f.edit(), /file revision conflict/); exercised(); prepared(f, 'external source\n');
  assert.equal(fs.readFileSync(f.stage, 'utf8'), outsider);
});
test('partial write failure still closes and removes the known owned stage', t => {
  const f = fixture(t), failure = Object.assign(Error('injected partial write'), { code: 'ENOSPC' });
  const exercised = interceptStage(t, f, { beforeWrite: (fd, args, write) => {
    write(fd, 'part'); throw failure;
  } });
  assert.throws(() => f.edit(), error => error === failure); exercised(); prepared(f);
  assert.equal(fs.existsSync(f.stage), false);
});
for (const exact of [false, true]) {
  test(`${exact ? 'exact-span' : 'whole-file'} replacement retains Unicode bytes, receipts and normal stage cleanup`, t => {
    const f = fixture(t), text = '\uFEFF한글😀\r\n$&', expected = exact ? text + '\n' : text;
    const exercised = interceptStage(t, f);
    const receipt = f.edit({ text, ...(exact ? { oldText: 'before' } : {}) });
    exercised(); assert.equal(fs.readFileSync(f.file, 'utf8'), expected);
    assert.equal(fs.readFileSync(receipt.backup, 'utf8'), original);
    assert.equal(fs.existsSync(f.stage), false);
    assert.deepEqual(fs.readdirSync(f.project), ['note.txt']);
    assert.deepEqual(inspectRecovery(f.runtime, 'stage-test'), { receipts: [receipt], unresolved: [] });
    const grant = grantWorkspace({ root: f.project, mode: 'read' });
    assert.equal(readWorkspace(grant, 'note.txt').sha256, receipt.afterSha256);
  });
}
test('create and delete retain their existing receipt paths without replacement stages', t => {
  const f = fixture(t), grant = grantWorkspace({ root: f.project, mode: 'edit' });
  const created = changeWorkspace(grant, f.runtime, 'stage-test', { path: 'new.txt', text: 'new', expectedSha256: null });
  const deleted = changeWorkspace(grant, f.runtime, 'stage-test', { path: 'new.txt', expectedSha256: created.afterSha256 }, true);
  assert.equal(created.action, 'create'); assert.equal(deleted.action, 'delete');
  assert.equal(fs.existsSync(join(f.project, 'new.txt')), false);
  const recovery = inspectRecovery(f.runtime, 'stage-test');
  assert.equal(recovery.receipts.length, 2); assert.deepEqual(recovery.unresolved, []);
  assert.deepEqual(fs.readdirSync(f.project), ['note.txt']);
});
