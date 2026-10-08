// Private presentation of an already built handoff. No task or execution authority.
import fs from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readBoundedFile } from './bounded-read.mjs';
import { boundedTextPage } from './bounded-text-page.mjs';

export const HANDOFF_MAX_BYTES = 128 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const messages = {
  HANDOFF_FILE_USAGE: 'usage: handoff <absolute-spec.json> [--save <new-absolute-file>]; read-handoff <absolute-file> --expected-sha256 <packet-sha256> [--offset N]',
  HANDOFF_FILE_INVALID: 'handoff file unavailable or invalid; preserve files and inspect',
  HANDOFF_FILE_CONFLICT: 'handoff file differs from the expected packet revision',
  HANDOFF_FILE_RANGE: 'handoff offset is outside the text or splits a Unicode or CRLF boundary',
};
const failure = (code = 'HANDOFF_FILE_INVALID') => Object.assign(Error(messages[code]), { code });
export const validHandoffPath = path => typeof path === 'string' && path.isWellFormed()
  && path.length <= 4096 && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path)
  // NTFS alternate streams mutate an existing file despite an exclusive stream create.
  && (process.platform !== 'win32' || !path.slice(/^[a-z]:[\\/]/i.test(path) ? 2 : 0).includes(':'))
  && !/[\\/]$/.test(path) && !['', '.', '..'].includes(basename(path));
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
function packetText(bytes) {
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const packet = JSON.parse(content);
  if (packet?.kind !== 'webgpt-handoff' || packet.version !== 1) throw failure();
  return content;
}

export function saveHandoffPacket(packet, destination) {
  if (!validHandoffPath(destination)) throw failure('HANDOFF_FILE_USAGE');
  try {
    const bytes = Buffer.from(JSON.stringify(packet));
    if (bytes.length > HANDOFF_MAX_BYTES) throw failure();
    packetText(bytes);
    const parent = fs.realpathSync.native(dirname(destination));
    const file = join(parent, basename(destination));
    // Bound receipt paths too; validate before creating anything.
    if (!validHandoffPath(file)) throw failure();
    const owner = fs.lstatSync(parent, { bigint: true });
    const checkParent = () => {
      const now = fs.lstatSync(parent, { bigint: true });
      if (!now.isDirectory() || now.isSymbolicLink() || !sameFile(owner, now)) throw failure();
    };
    checkParent();
    const fd = fs.openSync(file, 'wx', 0o600);
    let written;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw failure();
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      written = fs.fstatSync(fd, { bigint: true });
      if (!written.isFile() || written.nlink !== 1n || !sameFile(opened, written)
          || written.size !== BigInt(bytes.length)) throw failure();
    } finally { fs.closeSync(fd); }
    checkParent();
    const saved = readBoundedFile(file, HANDOFF_MAX_BYTES, failure);
    const now = fs.lstatSync(file, { bigint: true });
    if (!saved || !sameFile(saved.stat, written) || !saved.bytes.equals(bytes)
        || !now.isFile() || now.isSymbolicLink() || now.nlink !== 1n
        || !sameFile(now, written) || now.size !== BigInt(bytes.length)) throw failure();
    checkParent();
    return { source: 'local-handoff', saved: { path: file, bytes: bytes.length, sha256: hash(bytes) },
      contentsIncluded: false, deliveryVerified: false, grantsExecution: false };
  } catch { throw failure(); } // Native causes may contain private paths or packet text.
}

export function readHandoffPacket(file, options) {
  if (!validHandoffPath(file) || !options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['expectedSha256', 'offset'].includes(key))
      || typeof options.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedSha256)
      || !Number.isSafeInteger(options.offset === undefined ? 0 : options.offset) || options.offset < 0)
    throw failure('HANDOFF_FILE_USAGE');
  let content;
  try {
    const saved = readBoundedFile(file, HANDOFF_MAX_BYTES, failure);
    if (!saved) throw failure();
    const now = fs.lstatSync(file, { bigint: true });
    if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1n || !sameFile(now, saved.stat)
        || now.size !== BigInt(saved.bytes.length)) throw failure();
    if (hash(saved.bytes) !== options.expectedSha256) throw failure('HANDOFF_FILE_CONFLICT');
    content = packetText(saved.bytes);
  } catch (error) { throw failure(error.code === 'HANDOFF_FILE_CONFLICT' ? error.code : 'HANDOFF_FILE_INVALID'); }
  try {
    return boundedTextPage(content, options.offset ?? 0, { source: 'local-handoff',
      sha256: options.expectedSha256, integrity: 'verified-packet', sourceFilesChecked: false,
      deliveryVerified: false, grantsExecution: false });
  } catch { throw failure('HANDOFF_FILE_RANGE'); }
}

export function handoffReadCli(args) {
  const options = {}, flags = { '--expected-sha256': 'expectedSha256', '--offset': 'offset' };
  if (args.length % 2 !== 1) throw failure('HANDOFF_FILE_USAGE');
  for (let i = 1; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!Object.hasOwn(flags, args[i]) || Object.hasOwn(options, key)
        || (key === 'offset' && !/^(0|[1-9][0-9]*)$/.test(value))) throw failure('HANDOFF_FILE_USAGE');
    options[key] = key === 'offset' ? Number(value) : value;
  }
  return readHandoffPacket(args[0], options);
}

export function handoffFileDiagnostic(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'HANDOFF_FILE_INVALID';
  return { code, message: messages[code] };
}
