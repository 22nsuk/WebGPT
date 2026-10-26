import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, toNamespacedPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildHandoff, handoffCli } from './handoff.mjs';
import { saveHandoffPacket, readHandoffPacket, handoffReadCli, validHandoffPath, HANDOFF_MAX_BYTES } from './handoff-file.mjs';
import { boundedTextPage } from './bounded-text-page.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, delivery = 'named input') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-handoff-file-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'brief.txt'), specPath = join(dir, 'spec.json'), file = join(dir, '인계 # %.json');
  fs.writeFileSync(source, 'real brief\r\n🧪');
  const spec = { assignment: { id: 'owned', revision: 'rev2' }, assignee: 'pro',
    files: Array.from({ length: 6 }, (_, i) => ({ label: 'file' + i, role: i ? 'reference' : 'brief',
      source, requiredFor: ['implementation'], delivery })), checks: [] };
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const packet = buildHandoff(spec), content = JSON.stringify(packet);
  const run = args => spawnSync(process.execPath, [fileURLToPath(new URL('./client.mjs', import.meta.url)), ...args],
    { encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, WEBGPT_CONFIG: join(dir, 'absent-config'), WEBGPT_DATA_DIR: join(dir, 'no-runtime') } });
  return { dir, source, file, spec, specPath, packet, content, run };
}

test('long valid handoffs save exact legacy bytes and reconstruct through bounded CLI pages', t => {
  const f = fixture(t, ('한글🧪\\"\r\n').repeat(300));
  assert.ok(f.content.length > 20000);
  const legacy = f.run(['handoff', f.specPath]);
  assert.equal(legacy.status, 0, legacy.stderr); assert.deepEqual(JSON.parse(legacy.stdout), f.packet);
  const saved = f.run(['handoff', f.specPath, '--save', f.file]);
  assert.equal(saved.status, 0, saved.stderr); assert.ok(saved.stdout.length <= 20000);
  const receipt = JSON.parse(saved.stdout);
  assert.deepEqual(fs.readFileSync(f.file), Buffer.from(f.content));
  assert.equal(receipt.saved.sha256, hash(f.content)); assert.equal(receipt.saved.bytes, Buffer.byteLength(f.content));
  assert.equal(receipt.deliveryVerified, false); assert.equal(receipt.grantsExecution, false);
  assert.equal(receipt.contentsIncluded, false);
  fs.unlinkSync(f.source); fs.unlinkSync(f.specPath); // Offline lookup must not rebuild the handoff.
  let offset = 0, collected = '', pages = 0;
  do {
    const response = f.run(['read-handoff', f.file, '--expected-sha256', receipt.saved.sha256, '--offset', String(offset)]);
    assert.equal(response.status, 0, response.stderr); assert.ok(response.stdout.length <= 20000);
    const page = JSON.parse(response.stdout);
    assert.equal(page.startOffset, offset); assert.ok(page.endOffset > offset);
    assert.equal(page.sourceFilesChecked, false); assert.equal(page.deliveryVerified, false);
    assert.equal(page.grantsExecution, false); assert.equal(page.integrity, 'verified-packet');
    assert.ok(page.content.isWellFormed()); collected += page.content; offset = page.nextOffset;
    assert.ok(++pages < 100);
  } while (offset !== null);
  assert.ok(pages > 1); assert.equal(collected, f.content); assert.deepEqual(JSON.parse(collected), f.packet);
  assert.equal(fs.existsSync(join(f.dir, 'no-runtime')), false);
});

test('the saved packet hash covers feedback and assignee excluded from the input identity', t => {
  const f = fixture(t), saved = saveHandoffPacket(f.packet, f.file);
  f.spec.assignee = 'xhigh'; const changed = buildHandoff(f.spec);
  assert.equal(changed.assignment.inputIdentitySha256, f.packet.assignment.inputIdentitySha256);
  fs.writeFileSync(f.file, JSON.stringify(changed));
  assert.throws(() => readHandoffPacket(f.file, { expectedSha256: saved.saved.sha256 }), { code: 'HANDOFF_FILE_CONFLICT' });
  assert.throws(() => readHandoffPacket(f.file, { expectedSha256: changed.assignment.inputIdentitySha256 }), { code: 'HANDOFF_FILE_CONFLICT' });
});

test('Windows extended drive paths save exact packet bytes and retain exclusive creation', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), namespaced = toNamespacedPath(f.file);
  assert.match(namespaced, /^\\\\\?\\[a-z]:\\/i);
  const saved = saveHandoffPacket(f.packet, namespaced);
  assert.equal(saved.saved.sha256, hash(f.content));
  assert.equal(saved.saved.bytes, Buffer.byteLength(f.content));
  for (const file of [f.file, namespaced, saved.saved.path]) {
    assert.deepEqual(fs.readFileSync(file), Buffer.from(f.content));
    assert.equal(readHandoffPacket(file, { expectedSha256: saved.saved.sha256 }).content, f.content);
    assert.throws(() => saveHandoffPacket(f.packet, file), { code: 'HANDOFF_FILE_INVALID' });
  }
  assert.deepEqual(fs.readFileSync(namespaced), Buffer.from(f.content));
});

test('Windows extended drive reads verify the same native packet and expected hash', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), namespaced = toNamespacedPath(f.file), sha = hash(f.content);
  // Native I/O establishes that this spelling selects the same existing file.
  fs.writeFileSync(f.file, f.content);
  assert.deepEqual(fs.readFileSync(namespaced), fs.readFileSync(f.file));
  assert.deepEqual(readHandoffPacket(namespaced, { expectedSha256: sha }),
    readHandoffPacket(f.file, { expectedSha256: sha }));
  assert.throws(() => readHandoffPacket(namespaced, { expectedSha256: hash('other packet') }),
    { code: 'HANDOFF_FILE_CONFLICT' });
  const child = f.run(['read-handoff', namespaced, '--expected-sha256', sha]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).content, f.content);
});

test('Windows CLI saves and reads an extended drive path longer than MAX_PATH', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  let dir = f.dir;
  while (dir.length < 280) dir = join(dir, 'long-native-directory');
  fs.mkdirSync(toNamespacedPath(dir), { recursive: true });
  const ordinary = join(dir, '인계 # %.json'), namespaced = toNamespacedPath(ordinary);
  assert.ok(ordinary.length > 260);
  const child = f.run(['handoff', f.specPath, '--save', namespaced]);
  assert.equal(child.status, 0, child.stderr);
  const saved = JSON.parse(child.stdout);
  assert.equal(saved.saved.sha256, hash(f.content));
  assert.deepEqual(fs.readFileSync(namespaced), Buffer.from(f.content));
  assert.deepEqual(fs.readFileSync(ordinary), Buffer.from(f.content));
  for (const file of [ordinary, namespaced, saved.saved.path]) {
    const read = f.run(['read-handoff', file, '--expected-sha256', saved.saved.sha256]);
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).content, f.content);
  }
});

test('handoff path validation preserves native spellings and input limits', () => {
  const paths = process.platform === 'win32'
    ? ['C:\\private\\packet.json', 'c:/private/packet.json', '\\\\server\\share\\packet.json',
      '\\\\?\\C:\\private\\packet.json', '\\\\?\\c:\\private\\packet.json', '\\\\?\\UNC\\server\\share\\packet.json']
    : ['/private/packet.json', '/private/C:packet.json', '/private/\\\\?\\C:packet.json'];
  for (const file of paths) assert.equal(validHandoffPath(file), true, file);
  const base = paths[0];
  assert.equal(validHandoffPath(base + 'x'.repeat(4096 - base.length)), true);
  for (const file of ['', 'relative.json', base + '\0', base + '\n', base + '\x7f',
    base + '\ud800', base + '/', base + '\\', base + 'x'.repeat(4096)])
    assert.equal(validHandoffPath(file), false, JSON.stringify(file));
});

test('existing files, directories and hardlinks cannot be overwritten or certified', t => {
  const f = fixture(t); fs.writeFileSync(f.file, 'keep');
  assert.throws(() => saveHandoffPacket(f.packet, f.file), { code: 'HANDOFF_FILE_INVALID' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'keep');
  assert.throws(() => saveHandoffPacket(f.packet, f.dir), { code: 'HANDOFF_FILE_INVALID' });
  fs.unlinkSync(f.file); saveHandoffPacket(f.packet, f.file);
  const link = join(f.dir, 'hardlink'); fs.linkSync(f.file, link);
  assert.throws(() => saveHandoffPacket(f.packet, link), { code: 'HANDOFF_FILE_INVALID' });
  assert.throws(() => readHandoffPacket(f.file, { expectedSha256: hash(f.content) }), { code: 'HANDOFF_FILE_INVALID' });
  assert.equal(fs.readFileSync(link, 'utf8'), f.content);
});

test('directory links cannot be used as an output file or input packet', t => {
  const f = fixture(t), link = join(f.dir, 'link');
  fs.symlinkSync(f.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => saveHandoffPacket(f.packet, link), { code: 'HANDOFF_FILE_INVALID' });
  assert.throws(() => readHandoffPacket(link, { expectedSha256: hash(f.content) }), { code: 'HANDOFF_FILE_INVALID' });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

for (const kind of ['regular', 'dangling', 'unreadable']) {
  test(`handoff refuses a known ${kind} destination before creation`, t => {
    const f = fixture(t), stat = fs.lstatSync, open = fs.openSync;
    if (kind === 'regular') fs.writeFileSync(f.file, 'keep');
    let attempts = 0;
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
      if (file === f.file && kind !== 'regular') {
        if (kind === 'unreadable') throw Object.assign(Error('private-path-secret'), { code: 'EACCES' });
        // Observe a known dangling leaf without requiring Windows link privilege.
        return { isSymbolicLink: () => true, isFile: () => false };
      }
      return stat(file, ...args);
    });
    t.mock.method(fs, 'openSync', (file, ...args) => {
      if (file === f.file) {
        attempts++;
        // Do not simulate successful native creation or mutate a target.
        throw Object.assign(Error('private-path-secret'), { code: 'EEXIST' });
      }
      return open(file, ...args);
    });
    assert.throws(() => saveHandoffPacket(f.packet, f.file), error =>
      error.code === 'HANDOFF_FILE_INVALID' && !error.message.includes('private-path-secret') && !error.cause);
    assert.equal(attempts, 0, 'known entries and inspection errors must stop before open');
    if (kind === 'regular') assert.equal(fs.readFileSync(f.file, 'utf8'), 'keep');
    else assert.equal(fs.existsSync(f.file), false);
  });
}

for (const dangling of [false, true]) {
  test(`handoff preserves a real ${dangling ? 'dangling' : 'existing-target'} file symlink`, t => {
    const f = fixture(t), target = join(f.dir, 'link-target.txt');
    if (!dangling) fs.writeFileSync(target, 'keep');
    try { fs.symlinkSync(target, f.file, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('file symlink creation unavailable');
      throw error;
    }
    const before = fs.readlinkSync(f.file), open = fs.openSync;
    let attempts = 0;
    t.mock.method(fs, 'openSync', (file, ...args) => {
      if (file === f.file) attempts++;
      return open(file, ...args);
    });
    assert.throws(() => saveHandoffPacket(f.packet, f.file), { code: 'HANDOFF_FILE_INVALID' });
    assert.equal(attempts, 0);
    assert.ok(fs.lstatSync(f.file).isSymbolicLink());
    assert.equal(fs.readlinkSync(f.file), before);
    if (dangling) assert.equal(fs.existsSync(target), false);
    else assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  });
}

test('exclusive handoff creation preserves a file arriving after the absence check', t => {
  const f = fixture(t), open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === f.file) {
      // Use the original descriptor API so this cooperative arrival does not recurse.
      const fd = open(file, 'wx');
      try { fs.writeFileSync(fd, 'other creator'); } finally { fs.closeSync(fd); }
    }
    return open(file, ...args);
  });
  assert.throws(() => saveHandoffPacket(f.packet, f.file), { code: 'HANDOFF_FILE_INVALID' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'other creator');
});

test('Windows alternate streams cannot bypass new-file-only storage', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); fs.writeFileSync(f.file, 'keep');
  const streams = [f.file + ':packet', toNamespacedPath(f.file) + ':packet',
    toNamespacedPath(f.file) + ':packet:$DATA'];
  const invalid = [...streams, toNamespacedPath(f.file) + '::$DATA', toNamespacedPath(f.dir) + ':packet\\child.json',
    '\\\\?\\UNC\\server\\share\\packet.json:stream', '\\\\?\\UNC\\server:stream\\share\\packet.json',
    '\\\\?\\C:relative.json', '\\\\?\\C:/private/packet.json', '\\\\.\\C:\\private\\packet.json',
    '\\??\\C:\\private\\packet.json', '\\\\?\\GLOBALROOT\\Device\\C:\\private\\packet.json'];
  let opens = 0, resolutions = 0;
  const open = t.mock.method(fs, 'openSync', () => { opens++; throw Error('unexpected file open'); });
  const realpath = t.mock.method(fs.realpathSync, 'native', () => { resolutions++; throw Error('unexpected path resolution'); });
  for (const file of invalid) {
    assert.equal(validHandoffPath(file), false, file);
    assert.throws(() => saveHandoffPacket(f.packet, file), { code: 'HANDOFF_FILE_USAGE' });
    assert.throws(() => readHandoffPacket(file, { expectedSha256: hash(f.content) }), { code: 'HANDOFF_FILE_USAGE' });
  }
  assert.equal(opens, 0); assert.equal(resolutions, 0);
  open.mock.restore(); realpath.mock.restore();
  for (const stream of streams) assert.equal(fs.existsSync(stream), false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'keep');
});

test('failed flush retains evidence, redacts native errors and refuses an overwrite retry', t => {
  const f = fixture(t), mock = t.mock.method(fs, 'fsyncSync', () => { throw Error('private-path-secret'); });
  assert.throws(() => saveHandoffPacket(f.packet, f.file), e => e.code === 'HANDOFF_FILE_INVALID'
    && !e.message.includes('private-path-secret') && !e.cause);
  mock.mock.restore();
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.content);
  assert.throws(() => saveHandoffPacket(f.packet, f.file), { code: 'HANDOFF_FILE_INVALID' });
});

test('replacement after write cannot receive a successful receipt', t => {
  const f = fixture(t), original = fs.closeSync, preserved = join(f.dir, 'preserved');
  const mock = t.mock.method(fs, 'closeSync', fd => {
    original(fd); fs.renameSync(f.file, preserved); fs.writeFileSync(f.file, f.content);
  });
  assert.throws(() => saveHandoffPacket(f.packet, f.file), { code: 'HANDOFF_FILE_INVALID' });
  mock.mock.restore();
  assert.equal(fs.readFileSync(preserved, 'utf8'), f.content);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.content);
});

test('post-read identity and new hardlinks are checked even when content hash still matches', t => {
  const f = fixture(t); saveHandoffPacket(f.packet, f.file);
  const original = fs.lstatSync;
  let injected = false;
  const mock = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    // The boundary reader owns its named import; this intercepts the explicit final check.
    if (path === f.file && !injected) { injected = true; fs.linkSync(f.file, join(f.dir, 'added-link')); }
    return original(path, ...args);
  });
  assert.throws(() => readHandoffPacket(f.file, { expectedSha256: hash(f.content) }), { code: 'HANDOFF_FILE_INVALID' });
  mock.mock.restore(); assert.equal(injected, true);
});

test('missing, invalid, oversized and foreign packets reject with private-safe errors', t => {
  const f = fixture(t);
  assert.throws(() => readHandoffPacket(f.file, { expectedSha256: hash(f.content) }), { code: 'HANDOFF_FILE_INVALID' });
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('{private-secret'), Buffer.from('{"kind":"other","version":1}'),
    Buffer.from(JSON.stringify({ kind: 'webgpt-handoff', version: 2 })), Buffer.alloc(HANDOFF_MAX_BYTES + 1, 32)]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => readHandoffPacket(f.file, { expectedSha256: hash(bytes) }), e => e.code === 'HANDOFF_FILE_INVALID'
      && !e.message.includes(f.dir) && !e.message.includes('private-secret') && !e.cause);
  }
});

test('exact packet size ceiling remains readable, overflow cannot create a file', t => {
  const f = fixture(t), packet = { kind: 'webgpt-handoff', version: 1, text: '' };
  packet.text = 'x'.repeat(HANDOFF_MAX_BYTES - Buffer.byteLength(JSON.stringify(packet)));
  const saved = saveHandoffPacket(packet, f.file);
  assert.equal(saved.saved.bytes, HANDOFF_MAX_BYTES);
  assert.ok(readHandoffPacket(f.file, { expectedSha256: saved.saved.sha256 }).content.length > 0);
  packet.text += 'x'; const overflow = join(f.dir, 'overflow.json');
  assert.throws(() => saveHandoffPacket(packet, overflow), { code: 'HANDOFF_FILE_INVALID' });
  assert.equal(fs.existsSync(overflow), false);
});

test('usage fails before source reads and ranges preserve explicit Unicode boundaries', t => {
  const f = fixture(t, '🧪'), sha = hash(f.content);
  saveHandoffPacket(f.packet, f.file);
  for (const args of [[], [f.specPath, '--save'], [f.specPath, '--save', 'relative'],
    [f.specPath, '--save', f.file, '--save', f.file], [f.specPath, '--unknown', f.file]])
    assert.throws(() => handoffCli(args), { code: 'HANDOFF_INVALID' });
  for (const args of [[f.file], [f.file, '--expected-sha256', sha, '--offset', '00'],
    [f.file, '--expected-sha256', sha, '--offset', '1', '--offset', '2']])
    assert.throws(() => handoffReadCli(args), { code: 'HANDOFF_FILE_USAGE' });
  for (const offset of [null, -1, 0.5, Infinity])
    assert.throws(() => readHandoffPacket(f.file, { expectedSha256: sha, offset }), { code: 'HANDOFF_FILE_USAGE' });
  for (const offset of [f.content.indexOf('🧪') + 1, f.content.length, f.content.length + 1])
    assert.throws(() => readHandoffPacket(f.file, { expectedSha256: sha, offset }), { code: 'HANDOFF_FILE_RANGE' });
  const bad = f.run(['read-handoff', join(f.dir, 'private-path'), '--expected-sha256', sha]);
  assert.notEqual(bad.status, 0); assert.equal(bad.stdout, ''); assert.ok(!bad.stderr.includes('private-path'));
});

test('shared paging handles empty text, escaped controls, CRLF and bounded metadata', () => {
  for (const content of ['', '🧪\r\n"\\\u0001'.repeat(5000)]) {
    let offset = 0, all = '';
    do {
      const page = boundedTextPage(content, offset, { source: 'test' });
      assert.ok(JSON.stringify(page).length + 2 <= 20000); assert.ok(page.content.isWellFormed());
      if (page.nextOffset !== null) assert.notEqual(content.slice(page.nextOffset - 1, page.nextOffset + 1), '\r\n');
      all += page.content; offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(all, content);
  }
  assert.throws(() => boundedTextPage('🧪\r\n', 3, {}), RangeError);
  assert.throws(() => boundedTextPage('x', 0, { excessive: 'x'.repeat(20000) }), RangeError);
});
