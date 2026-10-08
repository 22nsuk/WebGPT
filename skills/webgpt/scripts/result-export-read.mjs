// Offline, read-only verification of a parent-owned result export.
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readBoundedFile } from './bounded-read.mjs';
import { resultMessages, validExportPath, MESSAGE_MAX_CHARS } from './result-export.mjs';
import { boundedTextPage } from './bounded-text-page.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const messages = {
  EXPORT_READ_USAGE: 'usage: client.mjs read-export <absolute-directory> --task-id <id> --expected-sha256 <sha256> [--offset N]',
  EXPORT_READ_INVALID: 'saved export is incomplete or invalid; preserve files and inspect',
  EXPORT_READ_CONFLICT: 'saved export differs from the expected task or result revision',
  EXPORT_READ_RANGE: 'export offset is outside the text or splits a Unicode or CRLF boundary',
};
const failure = (code = 'EXPORT_READ_INVALID') => Object.assign(Error(messages[code]), { code });
const invalid = () => failure();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

function verifyExport(directory, taskId, expectedSha256) {
  const owner = fs.lstatSync(directory, { bigint: true });
  if (!owner.isDirectory() || owner.isSymbolicLink()) throw invalid();
  const canonical = fs.realpathSync.native(directory);
  const checkDirectory = () => {
    for (const path of [directory, canonical]) {
      const now = fs.lstatSync(path, { bigint: true });
      if (!now.isDirectory() || now.isSymbolicLink() || !sameFile(owner, now)) throw invalid();
    }
  };
  const read = (file, limit) => {
    checkDirectory();
    // Only fixed/generated basenames reach the filesystem, never manifest paths.
    const path = join(canonical, file), saved = readBoundedFile(path, limit, invalid);
    if (!saved) throw invalid();
    const now = fs.lstatSync(path, { bigint: true });
    if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1n || !sameFile(saved.stat, now)
        || now.size !== BigInt(saved.bytes.length)) throw invalid();
    checkDirectory();
    return saved.bytes;
  };
  const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const manifest = JSON.parse(decode(read('manifest.json', 64 * 1024)));
  if (!manifest || manifest.kind !== 'webgpt-result-export' || manifest.version !== 1
      || !['completed', 'failed', 'cancelled'].includes(manifest.status)) throw invalid();
  if (manifest.taskId !== taskId || manifest.sourceSha256 !== expectedSha256)
    throw failure('EXPORT_READ_CONFLICT');
  const bytes = read('result.txt', 1024 * 1024);
  if (hash(bytes) !== expectedSha256) throw failure('EXPORT_READ_CONFLICT');
  const content = decode(bytes), parts = resultMessages(taskId, content, expectedSha256);
  const expected = { kind: 'webgpt-result-export', version: 1, taskId, status: manifest.status,
    integrity: 'verified', sourceSha256: expectedSha256,
    full: { file: 'result.txt', bytes: bytes.length, sha256: expectedSha256 },
    maxMessageChars: MESSAGE_MAX_CHARS, charUnit: 'UTF-16',
    messages: parts.map(({ text, ...part }) => part), chatDelivery: 'NOT_OBSERVED', collectedByExport: false };
  if (!isDeepStrictEqual(manifest, expected)) throw invalid();
  for (const part of parts) {
    if (!read(part.file, part.bytes).equals(Buffer.from(part.text))) throw invalid();
  }
  checkDirectory();
  return { content, messageCount: parts.length };
}

// Pins must come from the earlier trusted review/receipt, not this package itself.
// Verification observes the bytes read; it does not lock the directory against writers.
export function readSavedResult(directory, options) {
  if (!validExportPath(directory) || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['taskId', 'expectedSha256', 'offset'].includes(key)))
    throw failure('EXPORT_READ_USAGE');
  const { taskId, expectedSha256, offset = 0 } = options;
  if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(taskId)
      || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)
      || !Number.isSafeInteger(offset) || offset < 0) throw failure('EXPORT_READ_USAGE');
  // POSIX lstat('link/') follows a directory link. Remove only trailing separators,
  // not interior dot segments whose meaning can depend on linked ancestors.
  directory = directory.replace(process.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  let verified;
  try { verified = verifyExport(directory, taskId, expectedSha256); }
  catch (error) {
    // Native causes and parser messages can expose private paths/content to API users too.
    throw failure(error.code === 'EXPORT_READ_CONFLICT' ? error.code : 'EXPORT_READ_INVALID');
  }
  const { content, messageCount } = verified;
  try {
    return boundedTextPage(content, offset, { source: 'local-export', taskId, sha256: expectedSha256,
      integrity: 'verified', liveTaskChecked: false, chatDelivery: 'NOT_OBSERVED', messageCount });
  } catch { throw failure('EXPORT_READ_RANGE'); }
}

export function exportReadCli(args) {
  const options = {}, flags = { '--task-id': 'taskId', '--expected-sha256': 'expectedSha256', '--offset': 'offset' };
  if (args.length % 2 !== 1) throw failure('EXPORT_READ_USAGE');
  for (let i = 1; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!Object.hasOwn(flags, args[i]) || Object.hasOwn(options, key)
        || (key === 'offset' && !/^(0|[1-9][0-9]*)$/.test(value))) throw failure('EXPORT_READ_USAGE');
    options[key] = key === 'offset' ? Number(value) : value;
  }
  return readSavedResult(args[0], options);
}

export function exportReadDiagnostic(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'EXPORT_READ_INVALID';
  return { code, message: messages[code] };
}
