// Disposable parent-ledger fixtures only; no live browser, controller or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { registerDispatch, prepareDispatch, dispatchPrompt, inspectDispatch, dispatchCli,
  dispatchDiagnostic, textDigest } from './dispatch.mjs';

const limit = 2 * 1024 * 1024;
const nonce = '00000000-0000-4000-8000-000000000001';
const prompt = '검토할 본문 🧪\r\nPRIVATE_FIXTURE_ONLY';
const target = { tabId: 'owned-fixture-tab', chatUrl: null };
const spec = { taskId: 'owned', mode: 'pro', prompt, target };
const ready = () => ({ target, mode: 'pro', connectorSelected: true, approvalPending: false,
  composerSha256: null, lastUserMessageId: null });
const sent = () => ({ ...ready(), target: { ...target, chatUrl: 'https://chatgpt.com/c/fixture' },
  lastUserMessageId: 'new', userMessage: { id: 'new', previousId: null, role: 'user', bodySha256: textDigest(prompt) } });
async function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt dispatch 한글 ')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  await registerDispatch(file, spec);
  return { dir, file, before: fs.readFileSync(file), stage: file + '.tmp-' + nonce };
}
async function patched(t, methods, run, fixedNonce = false) {
  for (const [name, replacement] of Object.entries(methods)) t.mock.method(fs, name, replacement);
  if (fixedNonce) t.mock.method(crypto, 'randomUUID', () => nonce);
  syncBuiltinESMExports();
  try { return await run(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}
function link(t, targetFile, file) {
  try { fs.symlinkSync(targetFile, file, 'file'); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('symlink creation not permitted'); return false; }
    throw error;
  }
}
function redacted(error, f) {
  const value = JSON.stringify(dispatchDiagnostic(error));
  for (const privateText of [f.dir, prompt, 'PRIVATE_FIXTURE_ONLY', target.tabId]) assert.ok(!value.includes(privateText));
}

for (const kind of ['regular', 'directory', 'symlink', 'dangling', 'hardlink']) {
  test(`dispatch preserves an existing ${kind} stage instead of cleaning unowned evidence`, async t => {
    const f = await fixture(t), other = join(f.dir, 'original.txt');
    fs.writeFileSync(other, 'unowned evidence');
    if (kind === 'regular') fs.writeFileSync(f.stage, 'unowned evidence');
    else if (kind === 'directory') fs.mkdirSync(f.stage);
    else if (kind === 'hardlink') fs.linkSync(other, f.stage);
    else if (!link(t, kind === 'dangling' ? join(f.dir, 'missing') : other, f.stage)) return;
    await patched(t, {}, async () => {
      await assert.rejects(prepareDispatch(f.file, ready()), error => { redacted(error, f); return error.code === 'DISPATCH_STORAGE'; });
    }, true);
    assert.ok(fs.lstatSync(f.stage));
    assert.equal(fs.readFileSync(other, 'utf8'), 'unowned evidence');
    if (kind === 'regular' || kind === 'hardlink') assert.equal(fs.readFileSync(f.stage, 'utf8'), 'unowned evidence');
    assert.equal(fs.existsSync(join(f.dir, 'missing')), false);
    assert.deepEqual(fs.readFileSync(f.file), f.before);
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
  });
}

test('dispatch refuses a stage created after the absence check without deleting it', async t => {
  const f = await fixture(t), open = fs.openSync, write = fs.writeFileSync;
  let collision;
  await patched(t, { openSync(path, ...args) {
    if (typeof path === 'string' && path.startsWith(f.file + '.tmp-') && !collision) {
      collision = path; write(path, 'racing fixture evidence', { flag: 'wx' });
    }
    return open(path, ...args);
  } }, () => assert.rejects(prepareDispatch(f.file, ready()), { code: 'DISPATCH_STORAGE' }));
  assert.ok(collision);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'racing fixture evidence');
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});

test('a known dangling lock is refused before any creation-capable write', async t => {
  const f = await fixture(t), lock = f.file + '.dispatch.lock', missing = join(f.dir, 'missing');
  if (!link(t, missing, lock)) return;
  const open = fs.openSync, write = fs.writeFileSync;
  let attempted = 0;
  await patched(t, {
    openSync(path, ...args) { if (path === lock) attempted++; return open(path, ...args); },
    writeFileSync(path, ...args) { if (path === lock) attempted++; return write(path, ...args); },
  }, () => assert.rejects(inspectDispatch(f.file), { code: 'DISPATCH_LOCKED' }));
  assert.equal(attempted, 0);
  assert.ok(fs.lstatSync(lock).isSymbolicLink());
  assert.equal(fs.existsSync(missing), false);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});

for (const phase of ['prepared', 'sending', 'submitted']) for (const failure of ['write', 'flush', 'rename']) {
  test(`dispatch ${phase} ${failure} failure preserves stage and committed send barrier`, async t => {
    const f = await fixture(t);
    const original = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
    const descriptors = new Map(), phases = new Map();
    let failedStage, calls = 0;
    const fault = () => { throw Object.assign(Error('PRIVATE_FIXTURE_ONLY ' + f.dir), { code: 'EIO' }); };
    await patched(t, {
      openSync(path, ...args) {
        const fd = original.openSync(path, ...args); descriptors.set(fd, path); return fd;
      },
      writeFileSync(path, bytes, ...args) {
        const name = typeof path === 'number' ? descriptors.get(path) : path;
        if (typeof name === 'string' && name.startsWith(f.file + '.tmp-')) {
          const state = JSON.parse(bytes).dispatch.state; phases.set(name, state);
          if (failure === 'write' && state === phase) {
            failedStage = name;
            original.writeFileSync(path, Buffer.from(bytes).subarray(0, 16), ...args);
            fault();
          }
        }
        return original.writeFileSync(path, bytes, ...args);
      },
      fsyncSync(fd) {
        if (failure === 'flush' && phases.get(descriptors.get(fd)) === phase) { failedStage = descriptors.get(fd); fault(); }
        return original.fsyncSync(fd);
      },
      renameSync(from, to) {
        if (failure === 'rename' && phases.get(from) === phase) { failedStage = from; fault(); }
        return original.renameSync(from, to);
      },
    }, () => assert.rejects(dispatchPrompt(f.file, prompt, {
      observeReady: async () => ready(), fillAndSend: async () => { calls++; }, observeSent: async () => sent(),
    }), error => { redacted(error, f); return error.code === 'DISPATCH_STORAGE'; }));
    assert.ok(failedStage);
    assert.ok(fs.existsSync(failedStage), 'preserve even partially written or unflushed evidence');
    assert.equal(fs.readFileSync(failedStage).length > 0, true);
    if (failure !== 'write') assert.equal(JSON.parse(fs.readFileSync(failedStage)).dispatch.state, phase);
    const state = JSON.parse(fs.readFileSync(f.file)).dispatch.state;
    assert.equal(state, { prepared: 'registered', sending: 'prepared', submitted: 'sending' }[phase]);
    assert.equal(calls, phase === 'submitted' ? 1 : 0);
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
    if (phase === 'submitted') {
      await assert.rejects(dispatchPrompt(f.file, prompt, {
        observeReady: async () => { calls++; }, fillAndSend: async () => { calls++; }, observeSent: async () => sent(),
      }), { code: 'DISPATCH_BLOCKED' });
      assert.equal(calls, 1, 'retained candidate never authorizes another browser action');
    }
  });
}

for (const source of ['ledger', 'payload']) {
  test(`dispatch bounds actual ${source} bytes when the file grows after metadata validation`, async t => {
    const f = await fixture(t), payload = join(f.dir, 'payload.json'), destination = join(f.dir, 'new.json');
    fs.writeFileSync(payload, JSON.stringify(spec));
    const file = source === 'ledger' ? f.file : payload, initial = fs.readFileSync(file);
    const grownBytes = Buffer.concat([initial, Buffer.alloc(3 * 1024 * 1024 - initial.length, 32)]);
    const original = { openSync: fs.openSync, readFileSync: fs.readFileSync, readSync: fs.readSync, fstatSync: fs.fstatSync, closeSync: fs.closeSync };
    let fd, grown = false, consumed = 0, error;
    const grow = () => { if (!grown) { grown = true; fs.writeFileSync(file, grownBytes); } };
    await patched(t, {
      openSync(path, ...args) { const opened = original.openSync(path, ...args); if (path === file && (args[0] === 'r' || (typeof args[0] === 'number' && (args[0] & 3) === 0))) fd = opened; return opened; },
      closeSync(descriptor) { if (descriptor === fd) fd = undefined; return original.closeSync(descriptor); },
      fstatSync(descriptor, ...args) { const info = original.fstatSync(descriptor, ...args); if (descriptor === fd) grow(); return info; },
      readFileSync(path, ...args) {
        if (path === file) { grow(); const bytes = original.readFileSync(path, ...args); consumed = bytes.length; return bytes; }
        return original.readFileSync(path, ...args);
      },
      readSync(descriptor, ...args) { const count = original.readSync(descriptor, ...args); if (descriptor === fd) consumed += count; return count; },
    }, async () => {
      try { if (source === 'ledger') await inspectDispatch(f.file); else await dispatchCli(['register', destination, payload]); }
      catch (caught) { error = caught; }
    });
    t.diagnostic(JSON.stringify({ source, grown, consumed, code: error?.code ?? null }));
    assert.equal(grown, true);
    assert.ok(consumed <= limit + 1, `read ${consumed} bytes beyond the private-file ceiling`);
    assert.equal(consumed, limit + 1, 'measurement must include the overflow sentinel');
    assert.equal(error?.code, 'DISPATCH_LEDGER');
    redacted(error, f);
    assert.deepEqual(fs.readFileSync(file), grownBytes);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
  });
}

for (const source of ['ledger', 'payload']) test(`dispatch accepts an exact-limit ${source} without truncating its JSON`, async t => {
  const f = await fixture(t), payload = join(f.dir, 'payload.json'), destination = join(f.dir, 'new.json');
  const file = source === 'ledger' ? f.file : payload;
  const initial = source === 'ledger' ? f.before : Buffer.from(JSON.stringify(spec));
  fs.writeFileSync(file, Buffer.concat([initial, Buffer.alloc(limit - initial.length, 32)]));
  const result = source === 'ledger' ? await inspectDispatch(f.file) : await dispatchCli(['register', destination, payload]);
  assert.equal(result.state, 'registered');
  assert.equal(fs.statSync(file).size, limit);
});

test('dispatch closes the input descriptor on read failure and releases only its own lock', async t => {
  const f = await fixture(t), open = fs.openSync, read = fs.readSync;
  let fd, closed = false;
  const close = fs.closeSync;
  await patched(t, {
    openSync(path, ...args) { const result = open(path, ...args); if (path === f.file) fd = result; return result; },
    readSync(descriptor, ...args) { if (descriptor === fd && !closed) throw Object.assign(Error('private I/O failure'), { code: 'EIO' }); return read(descriptor, ...args); },
    closeSync(descriptor) { const result = close(descriptor); if (descriptor === fd) closed = true; return result; },
  }, () => assert.rejects(inspectDispatch(f.file), { code: 'DISPATCH_STORAGE' }));
  assert.equal(closed, true);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
  assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
});

for (const failure of ['write', 'flush']) test(`unconfirmed lock ${failure} retains evidence and blocks another parent`, async t => {
  const f = await fixture(t), lock = f.file + '.dispatch.lock';
  const open = fs.openSync, write = fs.writeFileSync, flush = fs.fsyncSync;
  let lockFd, reached = false;
  await patched(t, {
    openSync(path, ...args) { const fd = open(path, ...args); if (path === lock) lockFd = fd; return fd; },
    writeFileSync(path, bytes, ...args) {
      if (failure === 'write' && (path === lock || (typeof path === 'number' && path === lockFd))) {
        reached = true; write(path, '{', ...args); throw Object.assign(Error('fixture write failure'), { code: 'EIO' });
      }
      return write(path, bytes, ...args);
    },
    fsyncSync(fd) {
      if (failure === 'flush' && fd === lockFd) { reached = true; throw Object.assign(Error('fixture flush failure'), { code: 'EIO' }); }
      return flush(fd);
    },
  }, () => assert.rejects(prepareDispatch(f.file, ready()), { code: 'DISPATCH_STORAGE' }));
  assert.equal(reached, true);
  assert.ok(fs.existsSync(lock));
  const evidence = fs.readFileSync(lock);
  await assert.rejects(inspectDispatch(f.file), { code: 'DISPATCH_LOCKED' });
  assert.deepEqual(fs.readFileSync(lock), evidence);
  assert.deepEqual(fs.readFileSync(f.file), f.before);
});
