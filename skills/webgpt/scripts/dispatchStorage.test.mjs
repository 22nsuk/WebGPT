// Disposable parent-ledger fixtures only; no live browser, controller or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { registerDispatch, prepareDispatch, beginDispatch, dispatchPrompt, inspectDispatch, dispatchCli,
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

for (const held of [true, false]) test(`pre-lock displaced inode metadata does not bypass ${held ? 'the current owner' : 'the committed send barrier'}`, async t => {
  const f = await fixture(t), lock = f.file + '.dispatch.lock';
  if (held) fs.writeFileSync(lock, 'another parent owns publication', { mode: 0o600 });
  else await beginDispatch(f.file, { prompt, observation: ready() });
  const bytes = fs.readFileSync(f.file), lstat = fs.lstatSync;
  let observed = false;
  await patched(t, { lstatSync(file, ...args) {
    const info = lstat(file, ...args);
    if (file === f.file && !observed) {
      observed = true;
      // Model a path lookup returning metadata for an inode displaced by the
      // owner's atomic publication. The locked read must inspect the live file.
      info.nlink = 0;
    }
    return info;
  } }, () => assert.rejects(prepareDispatch(f.file, ready()), {
    code: held ? 'DISPATCH_LOCKED' : 'DISPATCH_BLOCKED',
  }));
  assert.equal(observed, true);
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  if (held) assert.equal(fs.readFileSync(lock, 'utf8'), 'another parent owns publication');
  else assert.equal(fs.existsSync(lock), false);
});

test('an actual displaced POSIX inode cannot preempt the active publication lock', {
  skip: process.platform === 'win32' && 'Windows refuses replacement of this open fixture file',
}, async t => {
  const f = await fixture(t), fd = fs.openSync(f.file, 'r'), replacement = join(f.dir, 'replacement.json');
  try {
    fs.writeFileSync(replacement, f.before, { mode: 0o600 });
    fs.renameSync(replacement, f.file);
    const displaced = fs.fstatSync(fd);
    assert.equal(displaced.nlink, 0);
    const lock = f.file + '.dispatch.lock';
    fs.writeFileSync(lock, 'publishing owner', { mode: 0o600 });
    const lstat = fs.lstatSync;
    let observed = false;
    await patched(t, { lstatSync(file, ...args) {
      if (file === f.file && !observed) { observed = true; return displaced; }
      return lstat(file, ...args);
    } }, () => assert.rejects(prepareDispatch(f.file, ready()), { code: 'DISPATCH_LOCKED' }));
    assert.equal(observed, true);
    assert.deepEqual(fs.readFileSync(f.file), f.before);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'publishing owner');
  } finally { fs.closeSync(fd); }
});

test('unlinked ledger metadata is still rejected by the locked read', async t => {
  const f = await fixture(t), lstat = fs.lstatSync;
  let reads = 0;
  await patched(t, { lstatSync(file, ...args) {
    const info = lstat(file, ...args);
    if (file === f.file) { reads++; info.nlink = 0; }
    return info;
  } }, () => assert.rejects(prepareDispatch(f.file, ready()), { code: 'DISPATCH_LEDGER' }));
  assert.ok(reads >= 2, 'validation includes a fresh lookup after acquiring the lock');
  assert.deepEqual(fs.readFileSync(f.file), f.before);
  assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
});

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

for (const [phase, initial] of [['prepared', 'registered'], ['sending', 'registered'], ['sending', 'prepared'], ['submitted', 'registered']])
for (const failure of ['write', 'flush', 'close', 'rename', 'published', 'swap']) {
  test(`dispatch ${phase} ${failure} failure from ${initial} preserves evidence and committed send barrier`, async t => {
    const f = await fixture(t);
    if (initial === 'prepared') await prepareDispatch(f.file, ready());
    const committed = fs.readFileSync(f.file);
    const original = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync, renameSync: fs.renameSync };
    const descriptors = new Map(), phases = new Map(), contents = new Map(), flushed = new Set();
    let failedStage, calls = 0;
    const fault = () => { throw Object.assign(Error('PRIVATE_FIXTURE_ONLY ' + f.dir), { code: 'EIO' }); };
    await patched(t, {
      openSync(path, ...args) {
        const fd = original.openSync(path, ...args); descriptors.set(fd, path); return fd;
      },
      writeFileSync(path, bytes, ...args) {
        const name = typeof path === 'number' ? descriptors.get(path) : path;
        if (typeof name === 'string' && name.startsWith(f.file + '.tmp-')) {
          const state = JSON.parse(bytes).dispatch.state; phases.set(name, state); contents.set(name, Buffer.from(bytes));
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
        const result = original.fsyncSync(fd); flushed.add(descriptors.get(fd)); return result;
      },
      closeSync(fd) {
        const path = descriptors.get(fd), result = original.closeSync(fd);
        descriptors.delete(fd);
        if (failure === 'close' && phases.get(path) === phase) { failedStage = path; fault(); }
        if (failure === 'swap' && phases.get(path) === phase && !failedStage) {
          failedStage = path;
          original.renameSync(path, path + '.held');
          // Real same-size replacement after the native flush AND close. Its
          // valid old state must never replace this attempt's send barrier.
          original.writeFileSync(path, Buffer.concat([f.before,
            Buffer.alloc(contents.get(path).length - f.before.length, 32)]), { flag: 'wx', mode: 0o600 });
        }
        return result;
      },
      renameSync(from, to) {
        if (failure === 'rename' && phases.get(from) === phase) { failedStage = from; fault(); }
        const result = original.renameSync(from, to);
        if (failure === 'published' && phases.get(from) === phase) { failedStage = from; fault(); }
        return result;
      },
    }, () => assert.rejects(phase === 'prepared' ? prepareDispatch(f.file, ready()) : dispatchPrompt(f.file, prompt, {
      observeReady: async () => ({ ...ready(), composerSha256: textDigest(prompt) }),
      fillAndSend: async () => { calls++; }, observeSent: async () => sent(),
    }), error => {
      redacted(error, f);
      if (failure === 'swap') return error.code === 'DISPATCH_CONFLICT' && error.stage === 'ledger_write';
      return error.code === 'DISPATCH_STORAGE' && error.reason === 'io_failed'
        && error.stage === (['rename', 'published'].includes(failure) ? 'ledger_publish' : 'ledger_write');
    }));
    assert.ok(failedStage);
    assert.equal(descriptors.size, 0, 'all native descriptors close even when publication fails');
    if (failure === 'published') assert.equal(fs.existsSync(failedStage), false, 'actual replacement consumed the stage');
    else {
      assert.ok(fs.existsSync(failedStage), 'preserve even partially written or unflushed evidence');
      assert.equal(fs.readFileSync(failedStage).length > 0, true);
      if (failure === 'swap') {
        assert.equal(flushed.has(failedStage), true);
        assert.deepEqual(fs.readFileSync(failedStage + '.held'), contents.get(failedStage));
        const replacement = fs.readFileSync(failedStage);
        assert.equal(replacement.length, contents.get(failedStage).length);
        assert.equal(JSON.parse(replacement).dispatch.state, 'registered');
      } else if (failure !== 'write') assert.equal(JSON.parse(fs.readFileSync(failedStage)).dispatch.state, phase);
    }
    const state = JSON.parse(fs.readFileSync(f.file)).dispatch.state;
    assert.equal(state, failure === 'published' ? phase : phase === 'submitted' ? 'sending' : initial);
    if (phase !== 'submitted' && failure !== 'published') assert.deepEqual(fs.readFileSync(f.file), committed);
    assert.equal(calls, phase === 'submitted' ? 1 : 0);
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
    if (['sending', 'submitted'].includes(state)) {
      const previousCalls = calls;
      await assert.rejects(dispatchPrompt(f.file, prompt, {
        observeReady: async () => { calls++; }, fillAndSend: async () => { calls++; }, observeSent: async () => sent(),
      }), { code: 'DISPATCH_BLOCKED' });
      assert.equal(calls, previousCalls, 'a committed send barrier blocks every later browser callback');
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
    const expected = source === 'ledger'
      ? { code: 'DISPATCH_LEDGER', stage: 'ledger_validate', reason: 'invalid_ledger' }
      : { code: 'DISPATCH_INPUT', stage: 'payload_read', reason: 'register_payload_file_invalid' };
    assert.equal(error?.code, expected.code);
    const diagnostic = dispatchDiagnostic(error);
    for (const [key, value] of Object.entries(expected)) assert.equal(diagnostic[key], value);
    redacted(error, f);
    assert.deepEqual(fs.readFileSync(file), grownBytes);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(destination + '.dispatch.lock'), false);
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

// Observe actual publication, not a helper call count. Every published candidate
// must have completed its own write, flush and close; the lock is a separate file.
async function publications(t, file, run) {
  const native = { open: fs.openSync, write: fs.writeFileSync, flush: fs.fsyncSync,
    close: fs.closeSync, rename: fs.renameSync };
  const descriptors = new Map(), stages = new Map(), published = [];
  await patched(t, {
    openSync(path, ...args) {
      const fd = native.open(path, ...args);
      if (typeof path === 'string' && path.startsWith(file + '.tmp-')) descriptors.set(fd, path);
      return fd;
    },
    writeFileSync(fd, bytes, ...args) {
      const result = native.write(fd, bytes, ...args), path = descriptors.get(fd);
      if (path) stages.set(path, { state: JSON.parse(bytes).dispatch.state,
        bytes: Buffer.byteLength(bytes), flushed: false, closed: false });
      return result;
    },
    fsyncSync(fd) {
      const result = native.flush(fd), stage = stages.get(descriptors.get(fd));
      if (stage) stage.flushed = true;
      return result;
    },
    closeSync(fd) {
      const result = native.close(fd), stage = stages.get(descriptors.get(fd));
      if (stage) stage.closed = true;
      descriptors.delete(fd);
      return result;
    },
    renameSync(from, to) {
      const result = native.rename(from, to);
      if (to === file) published.push({ ...stages.get(from) });
      return result;
    },
  }, () => run(published));
  assert.equal(descriptors.size, 0, 'all owned stage descriptors close');
  assert.equal(stages.size, published.length, 'successful work leaves no redundant stages');
  for (const stage of published) {
    assert.equal(stage.flushed, true, 'flush succeeds before publication');
    assert.equal(stage.closed, true, 'close succeeds before publication');
  }
  t.diagnostic(JSON.stringify({ states: published.map(item => item.state),
    publicationBytes: published.reduce((total, item) => total + item.bytes, 0) }));
}

for (const initial of ['registered', 'prepared']) for (const path of ['split', 'cli', 'adapter']) {
  test(`single begin publication from ${initial} through ${path} preserves readiness and send barrier`, async t => {
    const f = await fixture(t);
    if (initial === 'prepared') await prepareDispatch(f.file, ready());
    const prior = JSON.parse(fs.readFileSync(f.file));
    prior.parentEvidence = { disposition: 'retained', nested: ['preserve this field'] };
    fs.writeFileSync(f.file, JSON.stringify(prior), { mode: 0o600 });
    const observation = { ...ready(), composerSha256: textDigest(prompt) };
    const payload = join(f.dir, 'begin.json');
    fs.writeFileSync(payload, JSON.stringify({ prompt, observation }), { mode: 0o600 });
    let result, sends = 0;
    await publications(t, f.file, async published => {
      if (path === 'adapter') result = await dispatchPrompt(f.file, prompt, {
        observeReady: async () => observation,
        fillAndSend: async body => {
          sends++;
          assert.equal(body, prompt);
          assert.equal(JSON.parse(fs.readFileSync(f.file)).dispatch.state, 'sending');
          // The existing lock still spans the adapter. This refactor changes
          // publication granularity, not concurrent send/inspection authority.
          await assert.rejects(beginDispatch(f.file, { prompt, observation }), { code: 'DISPATCH_LOCKED' });
          assert.deepEqual(published.map(item => item.state), ['sending']);
          assert.equal(published[0].flushed, true);
          assert.equal(published[0].closed, true);
        },
        observeSent: async () => sent(),
      });
      else result = path === 'cli' ? await dispatchCli(['begin', f.file, payload])
        : await beginDispatch(f.file, { prompt, observation });
      assert.deepEqual(published.map(item => item.state), path === 'adapter' ? ['sending', 'submitted'] : ['sending']);
    });
    assert.equal(result.state, path === 'adapter' ? 'submitted' : 'sending');
    assert.equal(result.resendBlocked, true);
    assert.equal(sends, path === 'adapter' ? 1 : 0);
    const stored = JSON.parse(fs.readFileSync(f.file));
    assert.deepEqual(stored.parentEvidence, prior.parentEvidence);
    assert.deepEqual(stored.dispatch.before, observation, 'begin refreshes earlier preparation rather than trusting it');
    assert.equal(stored.dispatch.registeredAt, prior.dispatch.registeredAt);
    assert.ok(Number.isFinite(Date.parse(stored.dispatch.preparedAt)));
    assert.ok(Number.isFinite(Date.parse(stored.dispatch.sendingAt)));
    await assert.rejects(beginDispatch(f.file, { prompt, observation }), { code: 'DISPATCH_BLOCKED' });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), stored);
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
  });
}

test('explicit preparation still publishes its independently inspectable checkpoint', async t => {
  const f = await fixture(t), observation = ready();
  await publications(t, f.file, async published => {
    const result = await prepareDispatch(f.file, observation);
    assert.equal(result.state, 'prepared');
    assert.equal(result.resendBlocked, false);
    assert.deepEqual(published.map(item => item.state), ['prepared']);
  });
  const stored = JSON.parse(fs.readFileSync(f.file)).dispatch;
  assert.deepEqual(stored.before, observation);
  assert.ok(stored.preparedAt);
  assert.equal(Object.hasOwn(stored, 'sendingAt'), false);
  assert.equal((await inspectDispatch(f.file)).state, 'prepared');
});

for (const [reason, alter] of [
  ['prompt', input => { input.prompt += ' different'; }],
  ['connector', input => { input.observation.connectorSelected = false; }],
  ['approval', input => { input.observation.approvalPending = true; }],
  ['mode', input => { input.observation.mode = 'xhigh'; }],
  ['target', input => { input.observation.target = { ...target, tabId: 'different' }; }],
  ['composer', input => { input.observation.composerSha256 = textDigest('different'); }],
  ['predecessor', input => { input.observation.lastUserMessageId = 'unexpected'; }],
]) test(`begin rejects changed ${reason} without publishing over earlier preparation`, async t => {
  const f = await fixture(t);
  await prepareDispatch(f.file, ready());
  const committed = fs.readFileSync(f.file), payload = join(f.dir, 'begin.json');
  const input = { prompt, observation: ready() };
  alter(input);
  fs.writeFileSync(payload, JSON.stringify(input), { mode: 0o600 });
  let sends = 0;
  await publications(t, f.file, async published => {
    const expected = { code: reason === 'prompt' ? 'DISPATCH_INPUT' : 'DISPATCH_NOT_READY' };
    await assert.rejects(beginDispatch(f.file, input), expected);
    await assert.rejects(dispatchCli(['begin', f.file, payload]), expected);
    await assert.rejects(dispatchPrompt(f.file, input.prompt, {
      observeReady: async () => input.observation,
      fillAndSend: async () => { sends++; }, observeSent: async () => sent(),
    }), expected);
    assert.deepEqual(published, []);
  });
  assert.equal(sends, 0);
  assert.deepEqual(fs.readFileSync(f.file), committed);
  assert.equal(fs.existsSync(f.file + '.dispatch.lock'), false);
});

// The same exclusive creator publishes the parent lock and ledger candidates.
// Native replacements exercise that ownership boundary, not the read adapter.
for (const boundary of ['lock', 'stage'])
for (const damage of boundary === 'lock' ? ['same-bytes', 'hardlink', 'size']
  : ['same-bytes', 'hardlink', 'size', 'dev', 'ino', 'large-equal']) {
  test(`dispatch ${boundary} publication validates ${damage} after flush and close`, async t => {
    const f = await fixture(t), file = boundary === 'lock' ? f.file + '.dispatch.lock' : f.stage;
    const native = { open: fs.openSync, write: fs.writeFileSync, flush: fs.fsyncSync,
      close: fs.closeSync, stat: fs.fstatSync, named: fs.lstatSync };
    const large = 2n ** 60n, wide = ['dev', 'ino', 'large-equal'].includes(damage);
    let fd, bytes, closed = false, flushed = false, finalSeen = false, reached = false;
    await patched(t, {
      openSync(path, flags, ...args) {
        const result = native.open(path, flags, ...args);
        if (path === file && (flags & fs.constants.O_EXCL)) fd = result;
        return result;
      },
      fstatSync(descriptor, ...args) {
        const info = native.stat(descriptor, ...args);
        if (descriptor === fd && !closed && wide) { info.dev = large; info.ino = large; }
        return info;
      },
      writeFileSync(descriptor, value, ...args) {
        if (descriptor === fd && !closed) bytes = Buffer.from(value);
        return native.write(descriptor, value, ...args);
      },
      fsyncSync(descriptor) {
        const result = native.flush(descriptor);
        if (descriptor === fd && !closed) flushed = true;
        return result;
      },
      closeSync(descriptor) {
        const result = native.close(descriptor);
        if (descriptor === fd && !closed) {
          closed = true; reached = true;
          if (damage === 'hardlink') fs.linkSync(file, file + '.held');
          else if (damage !== 'large-equal') {
            if (damage !== 'size') fs.renameSync(file, file + '.held');
            // Bypass the observer for fixture writes; only publication owns fd.
            const replacement = native.open(file, damage === 'size' ? 'a' : 'wx', 0o600);
            try { native.write(replacement, damage === 'size' ? ' ' : bytes); }
            finally { native.close(replacement); }
          }
        }
        return result;
      },
      lstatSync(path, ...args) {
        const info = native.named(path, ...args);
        if (path === file && closed && !finalSeen) {
          finalSeen = true;
          if (wide) { info.dev = large; info.ino = large; if (damage !== 'large-equal') info[damage]++; }
        }
        return info;
      },
    }, async () => {
      const attempt = beginDispatch(f.file, { prompt, observation: ready() });
      if (damage === 'large-equal') assert.equal((await attempt).state, 'sending');
      else await assert.rejects(attempt, error => {
        redacted(error, f);
        return error.code === 'DISPATCH_CONFLICT' && error.stage === (boundary === 'lock' ? 'lock_acquire' : 'ledger_write');
      });
    }, true);
    assert.equal(reached && closed && flushed && finalSeen, true, 'reach the real flush/close and final observation');
    if (damage === 'large-equal') {
      assert.deepEqual(fs.readFileSync(f.file), bytes); assert.equal(fs.existsSync(file), false);
      await assert.rejects(beginDispatch(f.file, { prompt, observation: ready() }), { code: 'DISPATCH_BLOCKED' });
    } else {
      assert.deepEqual(fs.readFileSync(f.file), f.before);
      assert.deepEqual(fs.readFileSync(file), damage === 'size' ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes);
      if (damage !== 'size') assert.deepEqual(fs.readFileSync(file + '.held'), bytes);
      if (boundary === 'lock') await assert.rejects(inspectDispatch(f.file), { code: 'DISPATCH_LOCKED' });
    }
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), boundary === 'lock');
  });
}

for (const boundary of ['lock', 'stage']) for (const point of ['opened', 'final']) {
  test(`dispatch ${boundary} ${point} metadata failure preserves files and closes the writer`, async t => {
    const f = await fixture(t), file = boundary === 'lock' ? f.file + '.dispatch.lock' : f.stage;
    const native = { open: fs.openSync, stat: fs.fstatSync, named: fs.lstatSync, close: fs.closeSync };
    let fd, closed = false, reached = false;
    const fault = () => { reached = true; throw Object.assign(Error(f.dir), { code: 'EIO' }); };
    await patched(t, {
      openSync(path, flags, ...args) {
        const result = native.open(path, flags, ...args);
        if (path === file && (flags & fs.constants.O_EXCL)) fd = result;
        return result;
      },
      fstatSync(descriptor, ...args) {
        if (point === 'opened' && descriptor === fd && !closed) fault();
        return native.stat(descriptor, ...args);
      },
      lstatSync(path, ...args) {
        if (point === 'final' && path === file && closed) fault();
        return native.named(path, ...args);
      },
      closeSync(descriptor) {
        const result = native.close(descriptor); if (descriptor === fd) closed = true; return result;
      },
    }, () => assert.rejects(beginDispatch(f.file, { prompt, observation: ready() }), error => {
      redacted(error, f);
      return error.code === 'DISPATCH_STORAGE' && error.reason === 'io_failed'
        && error.stage === (boundary === 'lock' ? 'lock_acquire' : 'ledger_write');
    }), true);
    assert.equal(reached && closed, true);
    assert.deepEqual(fs.readFileSync(f.file), f.before);
    const bytes = fs.readFileSync(file);
    if (point === 'opened') assert.equal(bytes.length, 0);
    else assert.ok(bytes.length > 0);
    if (boundary === 'lock') await assert.rejects(inspectDispatch(f.file), { code: 'DISPATCH_LOCKED' });
    assert.equal(fs.existsSync(f.file + '.dispatch.lock'), boundary === 'lock');
    assert.deepEqual(fs.readFileSync(file), bytes);
  });
}
