import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, inspect } from 'node:util';
import { saveReviewedResult } from './result-export.mjs';
import { readSavedResult, exportReadCli } from './result-export-read.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cli = fileURLToPath(new URL('./client.mjs', import.meta.url));
function fixture(t, content = '한글 🧪\r\n'.repeat(4000), status = 'completed') {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-export-read-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'saved');
  const pin = { taskId: 'owned', expectedSha256: hash(content) };
  saveReviewedResult({ id: pin.taskId, status, integrity: 'verified', sha256: pin.expectedSha256, content }, directory);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const args = ['read-export', directory, '--task-id', pin.taskId, '--expected-sha256', pin.expectedSha256];
  const run = args => promisify(execFile)(process.execPath, [cli, ...args], {
    cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024,
    env: { ...process.env, WEBGPT_CONFIG: join(root, 'absent-config.json'), WEBGPT_DATA_DIR: join(root, 'absent-state') },
  });
  return { root, directory, pin, manifestPath, manifest, args, run };
}

test('offline pages reconstruct exact bytes within the serialized output limit', t => {
  for (const content of ['', '\ufeff한글 🧪\r\n\0"\\END', '\0'.repeat(40000),
    ('"\\🧪한글\r\n').repeat(7000), 'x'.repeat(1024 * 1024)]) {
    const f = fixture(t, content);
    let offset = 0, rebuilt = '', pages = 0;
    do {
      const page = readSavedResult(f.directory, { ...f.pin, offset });
      assert.ok(JSON.stringify(page).length + 2 <= 20000);
      assert.equal(page.startOffset, offset);
      assert.equal(page.endOffset, offset + page.content.length);
      assert.equal(page.totalChars, content.length);
      assert.ok(page.content.isWellFormed());
      assert.equal(page.content, content.slice(offset, page.endOffset));
      assert.equal(page.partial, offset !== 0 || page.endOffset < content.length);
      if (page.nextOffset !== null) {
        assert.ok(page.nextOffset > offset);
        assert.equal(page.nextOffset, page.endOffset);
        assert.ok(!(page.content.endsWith('\r') && content[page.nextOffset] === '\n'));
      }
      assert.equal(page.liveTaskChecked, false);
      assert.equal(page.chatDelivery, 'NOT_OBSERVED');
      rebuilt += page.content; offset = page.nextOffset; pages++;
      assert.ok(pages < 500);
    } while (offset !== null);
    assert.deepEqual(Buffer.from(rebuilt), Buffer.from(content));
    assert.equal(hash(rebuilt), f.pin.expectedSha256);
  }
});

test('CLI reads collected/offline exports without configuration and sanitizes API/CLI errors', async t => {
  const f = fixture(t, '\0'.repeat(6000), 'failed');
  const before = fs.readdirSync(f.directory).map(file => [file, hash(fs.readFileSync(join(f.directory, file)))]);
  const { stdout, stderr } = await f.run(f.args);
  assert.equal(stderr, ''); assert.ok(stdout.length <= 20000);
  const page = JSON.parse(stdout);
  assert.equal(page.taskStatusAtExport, undefined); assert.equal(page.status, undefined);
  assert.equal(page.integrity, 'verified');
  assert.equal(page.liveTaskChecked, false); assert.notEqual(page.nextOffset, null);
  const second = JSON.parse((await f.run([...f.args, '--offset', String(page.nextOffset)])).stdout);
  assert.equal(page.content + second.content, '\0'.repeat(6000));
  assert.equal(second.nextOffset, null); assert.equal(second.partial, true);
  assert.deepEqual(fs.readdirSync(f.directory).map(file => [file, hash(fs.readFileSync(join(f.directory, file)))]), before);
  fs.writeFileSync(f.manifestPath, '{private-manifest-secret');
  assert.throws(() => readSavedResult(f.directory, f.pin), error => {
    assert.equal(error.code, 'EXPORT_READ_INVALID'); assert.equal(error.cause, undefined);
    for (const text of [error.message, JSON.stringify(error), inspect(error)]) {
      assert.ok(!text.includes(f.root)); assert.ok(!text.includes('private-manifest-secret'));
    }
    return true;
  });
  await assert.rejects(f.run(f.args), error => {
    assert.equal(error.stdout, ''); assert.match(error.stderr, /EXPORT_READ_INVALID/);
    assert.ok(!error.stderr.includes(f.root)); assert.ok(!error.stderr.includes('private-manifest-secret'));
    return true;
  });
});

test('missing trusted pins and invalid options are rejected before filesystem access', t => {
  const f = fixture(t, 'x');
  const mock = t.mock.method(fs, 'lstatSync', () => assert.fail('invalid usage performed I/O'));
  for (const options of [undefined, {}, { taskId: 'owned' }, { expectedSha256: f.pin.expectedSha256 },
    { ...f.pin, offset: -1 }, { ...f.pin, offset: 1.5 }, { ...f.pin, offset: Infinity }, { ...f.pin, unknown: true }])
    assert.throws(() => readSavedResult(f.directory, options), { code: 'EXPORT_READ_USAGE' });
  for (const args of [[], [f.directory], [f.directory, '--task-id', 'owned'],
    [...f.args.slice(1), '--offset', '00'], [...f.args.slice(1), '--offset', '1e3'],
    [...f.args.slice(1), '--offset', '0', '--offset', '1'], [...f.args.slice(1), '--bogus', 'value']])
    assert.throws(() => exportReadCli(args), { code: 'EXPORT_READ_USAGE' });
  mock.mock.restore();
});

test('wrong identity, revision and Unicode/CRLF interior offsets are rejected', t => {
  const f = fixture(t, '🧪\r\n');
  for (const options of [{ ...f.pin, taskId: 'other' }, { ...f.pin, expectedSha256: '0'.repeat(64) }])
    assert.throws(() => readSavedResult(f.directory, options), { code: 'EXPORT_READ_CONFLICT' });
  for (const offset of [1, 3, 4, 99])
    assert.throws(() => readSavedResult(f.directory, { ...f.pin, offset }), { code: 'EXPORT_READ_RANGE' });
  assert.equal(readSavedResult(f.directory, { ...f.pin, offset: 2 }).content, '\r\n');
});

test('manifest metadata, ordering and filenames must describe the entire canonical package', async t => {
  const mutations = {
    traversal: m => { m.messages[0].file = '../outside.txt'; },
    absolute: m => { m.full.file = 'C:/private/result.txt'; },
    missing: m => { m.messages.pop(); },
    duplicate: m => { m.messages.push(m.messages[0]); },
    reordered: m => { m.messages.reverse(); },
    gap: m => { m.messages[1].start++; },
    digest: m => { m.messages[0].sha256 = '0'.repeat(64); },
    bytes: m => { m.full.bytes++; },
    header: m => { m.messages[0].headerChars++; },
    version: m => { m.version++; },
    lifecycle: m => { m.chatDelivery = 'COMPLETE'; },
    extra: m => { m.accepted = true; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
    const f = fixture(t); mutate(f.manifest);
    fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    assert.throws(() => readSavedResult(f.directory, f.pin), { code: 'EXPORT_READ_INVALID' });
  });
});

test('missing, damaged and oversized files fail even outside the requested first page', async t => {
  for (const kind of ['missing-manifest', 'missing-tail', 'damaged-tail', 'damaged-full', 'oversized-manifest', 'oversized-full'])
    await t.test(kind, t => {
      const f = fixture(t);
      const tail = join(f.directory, f.manifest.messages.at(-1).file);
      if (kind === 'missing-manifest') fs.unlinkSync(f.manifestPath);
      if (kind === 'missing-tail') fs.unlinkSync(tail);
      if (kind === 'damaged-tail') fs.writeFileSync(tail, 'wrong');
      if (kind === 'damaged-full') fs.writeFileSync(join(f.directory, 'result.txt'), 'wrong');
      if (kind === 'oversized-manifest') fs.writeFileSync(f.manifestPath, ' '.repeat(65537));
      if (kind === 'oversized-full') fs.writeFileSync(join(f.directory, 'result.txt'), 'x'.repeat(1024 * 1024 + 1));
      assert.throws(() => readSavedResult(f.directory, f.pin), error => /^EXPORT_READ_(INVALID|CONFLICT)$/.test(error.code));
    });
});

test('invalid UTF-8 fails even with a matching pinned raw-byte hash', t => {
  const f = fixture(t, 'x'), bad = Buffer.from([0xc3, 0x28]);
  f.pin.expectedSha256 = hash(bad); f.manifest.sourceSha256 = hash(bad);
  fs.writeFileSync(join(f.directory, 'result.txt'), bad);
  fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  assert.throws(() => readSavedResult(f.directory, f.pin), { code: 'EXPORT_READ_INVALID' });
});

test('hardlinked files and directory aliases cannot certify an export', t => {
  const f = fixture(t, 'keep');
  fs.linkSync(join(f.directory, 'result.txt'), join(f.root, 'hardlink'));
  assert.throws(() => readSavedResult(f.directory, f.pin), { code: 'EXPORT_READ_INVALID' });
  fs.unlinkSync(join(f.root, 'hardlink'));
  const link = join(f.root, 'alias'); fs.symlinkSync(f.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of [link, link + sep, link + sep + sep])
    assert.throws(() => readSavedResult(path, f.pin), { code: 'EXPORT_READ_INVALID' });
  assert.equal(readSavedResult(f.directory + sep, f.pin).content, 'keep');
  assert.equal(fs.readFileSync(join(f.directory, 'result.txt'), 'utf8'), 'keep');
});

test('stored terminal labels never become verified task state', t => {
  const f = fixture(t, 'body', 'failed');
  for (const status of ['completed', 'failed', 'cancelled']) {
    f.manifest.status = status; fs.writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
    const page = readSavedResult(f.directory, f.pin);
    assert.equal(page.status, undefined); assert.equal(page.taskStatusAtExport, undefined);
    assert.equal(page.liveTaskChecked, false); assert.equal(page.chatDelivery, 'NOT_OBSERVED');
    assert.equal(page.content, 'body');
  }
});

test('directory replacement during verification is detected without modifying either copy', t => {
  const f = fixture(t, 'keep'), original = fs.lstatSync, moved = join(f.root, 'preserved');
  let replaced = false;
  const mock = t.mock.method(fs, 'lstatSync', (path, ...args) => {
    if (!replaced && path === join(f.directory, 'message-001.txt')) {
      replaced = true; fs.renameSync(f.directory, moved); fs.mkdirSync(f.directory);
      fs.writeFileSync(join(f.directory, 'foreign'), 'keep-foreign');
    }
    return original(path, ...args);
  });
  assert.throws(() => readSavedResult(f.directory, f.pin), { code: 'EXPORT_READ_INVALID' });
  mock.mock.restore(); assert.equal(replaced, true);
  assert.equal(fs.readFileSync(join(moved, 'result.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(join(f.directory, 'foreign'), 'utf8'), 'keep-foreign');
});
