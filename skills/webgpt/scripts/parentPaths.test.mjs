import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildArtifactInput } from './artifact-input.mjs';
import { buildHandoff, handoffCli } from './handoff.mjs';
import { saveHandoffPacket, readHandoffPacket } from './handoff-file.mjs';
import { saveReviewedResult } from './result-export.mjs';
import { readSavedResult } from './result-export-read.mjs';
import { reviewTask } from './client.mjs';
import { prepareVerification, checkVerification } from './verification.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const client = fileURLToPath(new URL('./client.mjs', import.meta.url));
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-parent-paths-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'brief.txt'), specPath = join(dir, 'spec.json'), packetPath = join(dir, 'packet.json');
  const content = 'Private fixture 한글 🧪\r\n';
  fs.writeFileSync(source, content);
  const brief = { label: 'brief', role: 'brief', source, requiredFor: ['implementation'], delivery: 'named input' };
  const spec = { assignment: { id: 'owned', revision: 'rev1' }, assignee: 'pro', files: [brief], checks: [] };
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const packet = buildHandoff(spec), saved = saveHandoffPacket(packet, packetPath);
  const pin = { taskId: 'owned', expectedSha256: hash(content) };
  const review = { id: 'owned', status: 'completed', integrity: 'verified', content, sha256: pin.expectedSha256 };
  const directory = join(dir, 'export'); saveReviewedResult(review, directory);
  const config = join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ dataDir: join(dir, 'runtime'), mcpPort: 43137, controlPort: 43139 }));
  return { dir, source, specPath, spec, packetPath, packet, packetSha: saved.saved.sha256, pin, review, directory, config };
}

async function withoutAccess(t, f, work) {
  const calls = [], mocks = [];
  const blocked = name => () => { calls.push(name); throw Error('invalid path reached ' + name); };
  for (const name of ['statSync', 'lstatSync', 'openSync', 'readFileSync', 'mkdirSync', 'writeFileSync', 'realpathSync']) {
    const replacement = blocked(name);
    if (name === 'realpathSync') replacement.native = replacement;
    mocks.push(t.mock.method(fs, name, replacement));
  }
  const network = t.mock.method(globalThis, 'fetch', blocked('fetch'));
  const previousConfig = process.env.WEBGPT_CONFIG; process.env.WEBGPT_CONFIG = f.config;
  syncBuiltinESMExports();
  try { await work(); }
  finally {
    if (previousConfig === undefined) delete process.env.WEBGPT_CONFIG;
    else process.env.WEBGPT_CONFIG = previousConfig;
    network.mock.restore();
    for (const mock of mocks.reverse()) mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, [], 'invalid paths must precede source, configuration, output and network access');
}

const entries = [
  { name: 'artifact source', path: f => f.source, error: { code: 'INVALID_ARGUMENT' },
    call: (f, path) => buildArtifactInput({ source: path, label: 'brief' }) },
  { name: 'handoff later source', path: f => f.source, error: { code: 'HANDOFF_INVALID' },
    call: (f, path) => buildHandoff({ ...f.spec, files: [...f.spec.files,
      { ...f.spec.files[0], label: 'second', role: 'reference', source: path }] }) },
  { name: 'handoff spec', path: f => f.specPath, error: { code: 'HANDOFF_INVALID' },
    call: (f, path) => handoffCli([path]) },
  { name: 'handoff CLI destination', path: f => f.packetPath, error: { code: 'HANDOFF_INVALID' },
    call: (f, path) => handoffCli([f.specPath, '--save', path]) },
  { name: 'handoff API destination', path: f => f.packetPath, error: { code: 'HANDOFF_FILE_USAGE' },
    call: (f, path) => saveHandoffPacket(f.packet, path) },
  { name: 'handoff packet read', path: f => f.packetPath, error: { code: 'HANDOFF_FILE_USAGE' },
    call: (f, path) => readHandoffPacket(path, { expectedSha256: f.packetSha }) },
  { name: 'result export destination', path: f => f.directory, error: { code: 'REVIEW_EXPORT' },
    call: (f, path) => saveReviewedResult(f.review, path) },
  { name: 'result export read', path: f => f.directory, error: { code: 'EXPORT_READ_USAGE' },
    call: (f, path) => readSavedResult(path, f.pin) },
  { name: 'review destination before default configuration', path: f => f.directory, error: { code: 'REVIEW_USAGE' },
    call: (f, path) => reviewTask('owned', undefined, { saveResult: path }) },
  { name: 'verification prepare', path: f => join(f.dir, 'run'), error: /invalid verification input/,
    call: (f, path) => prepareVerification('text', path, 'pro') },
  { name: 'verification check before default configuration', path: f => join(f.dir, 'run'), error: /invalid verification input/,
    call: (f, path) => checkVerification(path) },
];

for (const entry of entries) test(entry.name + ' rejects NUL before accessing files or configuration', async t => {
  const f = fixture(t);
  await withoutAccess(t, f, async () => {
    await assert.rejects(async () => entry.call(f, entry.path(f) + '\0private'), entry.error);
  });
  assert.equal(fs.existsSync(join(f.dir, 'runtime')), false);
});

test('Windows parent paths reject both drive-less separators at every responsible caller', {
  skip: process.platform !== 'win32',
}, async t => {
  const f = fixture(t);
  await withoutAccess(t, f, async () => {
    for (const entry of entries) {
      const selected = entry.path(f);
      const rootOnly = /^[A-Za-z]:/.test(selected) ? selected.slice(2) : '\\private\\selected';
      for (const path of [rootOnly, rootOnly.replaceAll('\\', '/')])
        await assert.rejects(async () => entry.call(f, path), entry.error, entry.name);
    }
  });
});

test('Windows client CLI cannot select real fixture evidence through the current drive', {
  skip: process.platform !== 'win32',
}, t => {
  const f = fixture(t);
  if (!/^[A-Za-z]:\\/.test(f.dir)) return t.skip('drive-backed temporary fixture required');
  const destination = join(f.dir, 'new-packet.json'), names = fs.readdirSync(f.dir).sort();
  // Run on the fixture drive: the pre-fix implementation would read these real
  // files successfully, or create the requested new packet in this directory.
  const cases = [
    [f.specPath, path => ['handoff', path], 'HANDOFF_FAILED'],
    [destination, path => ['handoff', f.specPath, '--save', path], 'HANDOFF_FAILED'],
    [f.packetPath, path => ['read-handoff', path, '--expected-sha256', f.packetSha], 'HANDOFF_FILE_USAGE'],
    [f.directory, path => ['read-export', path, '--task-id', 'owned', '--expected-sha256', f.pin.expectedSha256], 'EXPORT_READ_USAGE'],
  ];
  for (const [selected, args, code] of cases) for (const separator of ['\\', '/']) {
    const path = selected.slice(2).replaceAll('\\', separator);
    const result = spawnSync(process.execPath, [client, ...args(path)], {
      cwd: f.dir, env: { ...process.env, WEBGPT_CONFIG: f.config }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.equal(result.error, undefined); assert.equal(result.signal, null);
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr.replace(/^WebGPT: /, '')).code, code);
    assert.equal(result.stderr.includes(f.dir), false);
  }
  assert.deepEqual(fs.readdirSync(f.dir).sort(), names);
  assert.equal(readHandoffPacket(f.packetPath, { expectedSha256: f.packetSha }).content, JSON.stringify(f.packet));
  assert.equal(readSavedResult(f.directory, f.pin).content, f.review.content);
});
