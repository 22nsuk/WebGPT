// Parent-only evidence preparation. Never imported by the worker or controller.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_WINDOW_BYTES = 8 * 1024;
export const MAX_INPUT_BYTES = 64 * 1024;
const MAX_WINDOWS = 8;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validPath = value => typeof value === 'string' && value.isWellFormed() &&
  isAbsolute(value) && !value.includes('\0');

class EvidenceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new EvidenceError(code, message); };
const changed = () => fail('SOURCE_CHANGED', 'Source changed while reading; no evidence emitted.');
const sameFile = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
  .every(key => a[key] === b[key]);

function regular(stat) {
  if (!stat.isFile() || stat.nlink !== 1n)
    fail('UNSUPPORTED_SOURCE', 'Source must be a regular, single-link file, not a symlink.');
  if (stat.size < 0n || stat.size > BigInt(MAX_SOURCE_BYTES))
    fail('SOURCE_TOO_LARGE', 'Source exceeds the 256 MiB inspection limit.');
}

function options({ source, label, view, ranges, expectedSha256 }) {
  if (!validPath(source))
    fail('INVALID_ARGUMENT', 'source must be a well-formed absolute local file path.');
  if (typeof label !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(label))
    fail('INVALID_ARGUMENT', 'label must contain 1-64 ASCII letters, digits, dots, underscores or hyphens.');
  if (!['metadata', 'text', 'hex'].includes(view) || !Array.isArray(ranges) || ranges.length > MAX_WINDOWS)
    fail('INVALID_ARGUMENT', 'Use metadata, text or hex and at most eight ranges.');
  if ((view === 'metadata') !== (ranges.length === 0))
    fail('INVALID_ARGUMENT', 'metadata takes no ranges; text and hex require explicit byte ranges.');
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)))
    fail('INVALID_ARGUMENT', 'expectedSha256 must be a lowercase whole-source SHA-256.');
  let total = 0;
  const selected = ranges.map(range => {
    if (!range || !Number.isSafeInteger(range.offset) || range.offset < 0 ||
        !Number.isSafeInteger(range.length) || range.length < 1 ||
        !Number.isSafeInteger(range.offset + range.length))
      fail('INVALID_ARGUMENT', 'Ranges require safe nonnegative byte offsets and positive lengths.');
    total += range.length;
    return { offset: range.offset, length: range.length };
  }).sort((a, b) => a.offset - b.offset);
  if (total > MAX_WINDOW_BYTES)
    fail('INVALID_ARGUMENT', 'Combined requested ranges exceed 8 KiB.');
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].offset < selected[i - 1].offset + selected[i - 1].length)
      fail('INVALID_ARGUMENT', 'Ranges must not overlap.');
  }
  return selected;
}

/** Hash a whole bounded source once, retaining only explicitly selected windows.
 * Paths/commands/environment are not copied into the returned shareable record.
 * This is a cooperative parent-side read, not a filesystem sandbox or snapshot.
 */
export function buildArtifactInput({ source, label, view = 'metadata', ranges = [], expectedSha256 } = {}) {
  const selected = options({ source, label, view, ranges, expectedSha256 });
  const before = fs.lstatSync(source, { bigint: true });
  regular(before);
  const size = Number(before.size);
  if (selected.some(range => range.offset > size))
    fail('INVALID_ARGUMENT', 'Range starts beyond the source end.');
  const windows = selected.map(range => ({ ...range,
    bytes: Buffer.alloc(Math.min(range.length, size - range.offset)),
  }));
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fd = fs.openSync(source, flags);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    regular(opened);
    if (!sameFile(before, opened)) changed();
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    // Initial size + one sentinel bounds actual I/O, even if a writer keeps growing it.
    while (position <= size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - position), position);
      if (count === 0) break;
      if (position + count > size) changed();
      digest.update(buffer.subarray(0, count));
      for (const window of windows) {
        const start = Math.max(position, window.offset);
        const end = Math.min(position + count, window.offset + window.bytes.length);
        if (start < end) buffer.copy(window.bytes, start - window.offset, start - position, end - position);
      }
      position += count;
    }
    if (position !== size || !sameFile(before, fs.fstatSync(fd, { bigint: true })) ||
        !sameFile(before, fs.lstatSync(source, { bigint: true }))) changed();
    const sha256 = digest.digest('hex');
    if (expectedSha256 !== undefined && expectedSha256 !== sha256)
      fail('REVISION_CONFLICT', 'Whole-source SHA-256 does not match; no evidence emitted.');
    const rendered = windows.map(({ offset, length, bytes }) => {
      let content;
      if (view === 'hex') content = bytes.toString('hex');
      else {
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { fail('UNSUPPORTED_TEXT', 'Selected bytes are not complete UTF-8; align the range or use hex.'); }
        if (content.includes('\0')) fail('UNSUPPORTED_TEXT', 'Selected bytes contain NUL; use hex.');
      }
      return { offsetBytes: offset, requestedBytes: length, returnedBytes: bytes.length,
        endExclusiveBytes: offset + bytes.length, truncatedAtEof: bytes.length < length,
        sha256: hash(bytes), content };
    });
    const captured = windows.reduce((sum, window) => sum + window.bytes.length, 0);
    return { kind: 'webgpt-artifact-input', version: 1,
      source: { label, sizeBytes: size, sha256 }, view,
      textValidation: view === 'text' ? 'selected-windows-only' : null,
      omittedBytes: size - captured, windows: rendered };
  } finally { fs.closeSync(fd); }
}

export function serializeArtifactInput(input) {
  const text = JSON.stringify(input) + '\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES)
    fail('INPUT_TOO_LARGE', 'Encoded evidence exceeds 64 KiB.');
  return text;
}

const usage = `Usage: node artifact-input.mjs --source <absolute-file> --label <safe-name> --out <new-absolute-file>
  [--view metadata|text|hex] [--range <byte-offset>:<byte-length>]...
  [--expected-sha256 <whole-source-sha256>]
Parent-only: reads one regular source (<=256 MiB), hashes it fully, and creates a new UTF-8 evidence file.
Default is metadata only. At most eight non-overlapping ranges, 8 KiB combined; encoded output <=64 KiB.
No commands, uploads, worker grants, automatic redaction, source writes or overwrites. See references/artifact-inputs.md.
`;

function run(argv) {
  const { values, tokens } = parseArgs({ args: argv, strict: true, allowPositionals: false, tokens: true,
    options: { source: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' },
      view: { type: 'string' }, range: { type: 'string', multiple: true },
      'expected-sha256': { type: 'string' }, help: { type: 'boolean' } } });
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (token.name !== 'range' && seen.has(token.name)) fail('INVALID_ARGUMENT', 'Duplicate option.');
    seen.add(token.name);
  }
  if (values.help && tokens.length === 1) { process.stdout.write(usage); return; }
  if (values.help || !validPath(values.out))
    fail('INVALID_ARGUMENT', 'Provide a new well-formed absolute --out path, or --help alone.');
  const ranges = (values.range ?? []).map(value => {
    if (!/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(value))
      fail('INVALID_ARGUMENT', 'Use --range byte-offset:byte-length with decimal integers.');
    const [offset, length] = value.split(':').map(Number);
    return { offset, length };
  });
  const text = serializeArtifactInput(buildArtifactInput({ source: values.source, label: values.label,
    view: values.view, ranges, expectedSha256: values['expected-sha256'] }));
  // Validate all evidence before exclusive creation. A failed write is preserved, never retried or removed.
  const fd = fs.openSync(values.out, 'wx', 0o600);
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  process.stdout.write(JSON.stringify({ ok: true, inputBytes: Buffer.byteLength(text), sha256: hash(text) }) + '\n');
}

function isCliEntry() {
  // Keep this built-in-only helper usable through a preserved leaf symlink.
  // A relative cli-entry.mjs import would resolve beside that link, not its target.
  // cliImports.test.mjs owns the shared entry contract for both implementations.
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  const entry = process.argv[1];
  if (typeof entry !== 'string' || !entry || entry === '-' || !entry.isWellFormed() || entry.includes('\0')) return false;
  // On earlier Node 22, eval/print positional arguments are data, not an entry.
  if (process.execArgv.some(arg => /^--(?:eval|print)(?:=|$)/.test(arg) || /^-[ep](?:[^-]|$)/.test(arg))) return false;
  const url = new URL(import.meta.url);
  if (url.protocol !== 'file:' || url.search || url.hash) return false;
  // Normalize both sides: --preserve-symlinks-main also preserves import.meta.url.
  try { return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(url)); }
  catch (error) {
    // A renamed importer need not exist; permission/I/O failures are not absence.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

try {
  if (isCliEntry()) run(process.argv.slice(2));
} catch (error) {
  // Native filesystem/parser messages can contain private paths or supplied arguments.
  const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'ERROR';
  process.stderr.write(JSON.stringify({ ok: false, code,
    message: error instanceof EvidenceError ? error.message : 'Evidence preparation failed; inspect private inputs/output before retrying.' }) + '\n');
  process.exitCode = 1;
}
