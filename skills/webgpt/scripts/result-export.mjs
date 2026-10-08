// Parent-only presentation copies. The controller's result and lifecycle stay authoritative.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, isAbsolute, join } from 'node:path';
import { readBoundedFile } from './bounded-read.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(Error('result export unavailable; preserve files and inspect'), { code: 'REVIEW_EXPORT' }); };
export const MESSAGE_MAX_CHARS = 20000;
const PAYLOAD_CHARS = 18000; // Leave room for identity/sequence headers in each message file.

export function validExportPath(path) {
  return typeof path === 'string' && path.isWellFormed() && isAbsolute(path) && !path.includes('\0')
    && !['', '.', '..'].includes(basename(path));
}

// Offsets are UTF-16 units into the exact source, not byte offsets or rendered Markdown.
// Prefer line boundaries; even a single long line is split without losing its tail.
export function resultMessages(id, content, sha256) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)
      || typeof content !== 'string' || !content.isWellFormed() || Buffer.byteLength(content) > 1024 * 1024
      || hash(content) !== sha256) fail();
  const bodies = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + PAYLOAD_CHARS, content.length);
    if (end < content.length) {
      const newline = content.lastIndexOf('\n', end - 1);
      if (newline >= start) end = newline + 1;
      else if ((content.charCodeAt(end - 1) >= 0xd800 && content.charCodeAt(end - 1) <= 0xdbff)
          || (content[end - 1] === '\r' && content[end] === '\n')) end--;
    }
    bodies.push({ start, end, body: content.slice(start, end) }); start = end;
  }
  if (!bodies.length) bodies.push({ start: 0, end: 0, body: '' });
  return bodies.map(({ start, end, body }, i) => {
    const header = `WebGPT result ${id}\nSHA-256: ${sha256}\nPart ${i + 1}/${bodies.length}\n\n`;
    const text = header + body;
    if (text.length > MESSAGE_MAX_CHARS) fail();
    return { file: `message-${String(i + 1).padStart(3, '0')}.txt`, index: i + 1,
      start, end, headerChars: header.length, chars: text.length, bytes: Buffer.byteLength(text), sha256: hash(text), text };
  });
}

// New directory only, manifest last. Failures retain partial evidence, never recursively delete.
// The caller chooses a private parent directory; Windows ACLs inherit from that parent.
export function saveReviewedResult(review, destination) {
  if (!validExportPath(destination) || typeof review?.content !== 'string' || !review.content.isWellFormed()
      || review.integrity !== 'verified' || review.partial !== undefined
      || !['completed', 'failed', 'cancelled'].includes(review.status)) fail();
  const parts = resultMessages(review.id, review.content, review.sha256);
  const parent = fs.realpathSync.native(dirname(destination));
  const directory = join(parent, basename(destination));
  fs.mkdirSync(directory, { mode: 0o700 }); // No recursive create, no existing directory reuse.
  const owner = fs.lstatSync(directory, { bigint: true });
  const checkDirectory = () => {
    const now = fs.lstatSync(directory, { bigint: true });
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== owner.dev || now.ino !== owner.ino) fail();
  };
  const writtenFiles = [];
  const verify = ({ path, bytes, stat }) => {
    checkDirectory();
    const saved = readBoundedFile(path, bytes.length, fail);
    const current = fs.lstatSync(path, { bigint: true });
    if (!saved || saved.stat.dev !== stat.dev || saved.stat.ino !== stat.ino || !saved.bytes.equals(bytes)
        || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n
        || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== BigInt(bytes.length)) fail();
  };
  const write = (file, text) => {
    checkDirectory();
    const path = join(directory, file), bytes = Buffer.from(text);
    const fd = fs.openSync(path, 'wx', 0o600);
    let written;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) fail();
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      written = fs.fstatSync(fd, { bigint: true });
      if (!written.isFile() || written.nlink !== 1n || written.dev !== opened.dev || written.ino !== opened.ino
          || written.size !== BigInt(bytes.length)) fail();
    } finally { fs.closeSync(fd); }
    const evidence = { path, bytes, stat: written };
    verify(evidence); writtenFiles.push(evidence);
    return { file, bytes: bytes.length, sha256: hash(bytes) };
  };
  const full = write('result.txt', review.content);
  const messages = parts.map(({ text, ...part }) => {
    write(part.file, text); return part;
  });
  const manifest = { kind: 'webgpt-result-export', version: 1, taskId: review.id, status: review.status,
    integrity: 'verified', sourceSha256: review.sha256, full, maxMessageChars: MESSAGE_MAX_CHARS,
    charUnit: 'UTF-16', messages, chatDelivery: 'NOT_OBSERVED', collectedByExport: false };
  // Only this receipt marks a completely written package; it is not a chat delivery receipt.
  for (const evidence of writtenFiles) verify(evidence);
  write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  return { directory, manifest: join(directory, 'manifest.json'), full: { ...full, path: join(directory, full.file) },
    messageCount: messages.length, maxMessageChars: MESSAGE_MAX_CHARS, chatDelivery: 'NOT_OBSERVED' };
}
