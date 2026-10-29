import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = name => JSON.stringify(new URL('./' + name + '.mjs', import.meta.url).href);
function win32Probe(body, setup = '') {
  // Keep real Win32 parsing and caller code on every host, without an SMB share.
  // The child isolates builtin substitutions from the test runner and other files.
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { tmpdir } from 'node:os';
    import { createHash } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { saveReviewedResult } from ${moduleUrl('result-export')};
    import { readSavedResult, exportReadCli } from ${moduleUrl('result-export-read')};
    import { saveHandoffPacket } from ${moduleUrl('handoff-file')};
    import { handoffCli } from ${moduleUrl('handoff')};
    import { reviewTask } from ${moduleUrl('client')};
    import { prepareVerification } from ${moduleUrl('verification')};
    import { registerDispatch, diagnoseDispatch, dispatchCli } from ${moduleUrl('dispatch')};
    const content = 'fixture 한글 🧪\\r\\n';
    const pin = { taskId: 'owned', expectedSha256: createHash('sha256').update(content).digest('hex') };
    const review = { id: pin.taskId, status: 'completed', integrity: 'verified', content, sha256: pin.expectedSha256 };
    const packet = { kind: 'webgpt-handoff', version: 1 };
    const spec = { taskId: 'owned', mode: 'pro', prompt: 'fixture only', target: { tabId: 'owned-tab', chatUrl: null } };
    const nativeFs = Object.fromEntries(['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readFileSync', 'mkdirSync', 'writeFileSync']
      .map(name => [name, fs[name]]));
    const nativeRealpath = fs.realpathSync.native, nativePath = { ...path };
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    let cleanup = () => {};
    try {
      ${setup}
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      Object.assign(path, path.win32);
      syncBuiltinESMExports();
      ${body}
    } finally {
      Object.assign(fs, nativeFs); fs.realpathSync.native = nativeRealpath;
      Object.assign(path, nativePath);
      Object.defineProperty(process, 'platform', platform);
      syncBuiltinESMExports(); cleanup();
    }
  `], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
}

const roots = ['\\\\server\\share', '\\\\server\\share\\', '//server/share', '//server/share/',
  'C:\\', 'C:/', '\\\\?\\C:\\',
  '\\\\?\\UNC\\server\\share', '\\\\?\\UNC\\server\\share\\'];
const noAccess = `
  const accesses = [];
  const blocked = name => () => { accesses.push(name); throw Error('unexpected access: ' + name); };
  for (const name of ['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readFileSync', 'mkdirSync', 'writeFileSync']) {
    const replacement = blocked(name);
    if (name === 'realpathSync') replacement.native = replacement;
    fs[name] = replacement;
  }
  globalThis.fetch = blocked('fetch');
  process.env.WEBGPT_CONFIG = 'C:\\\\private\\\\config.json';
  syncBuiltinESMExports();
`;
const creators = [
  ['result export', 'saveReviewedResult(review, selected)', "{ code: 'REVIEW_EXPORT' }"],
  ['review export preflight', "reviewTask('owned', undefined, { saveResult: selected })", "{ code: 'REVIEW_USAGE' }"],
  ['handoff output', 'saveHandoffPacket(packet, selected)', "{ code: 'HANDOFF_FILE_USAGE' }"],
  ['handoff CLI preflight', String.raw`handoffCli(['C:\\private\\spec.json', '--save', selected])`, "{ code: 'HANDOFF_INVALID' }"],
  ['verification prepare', "prepareVerification('text', selected, 'pro')", '/invalid verification input/'],
];
for (const [name, call, expected] of creators) test(name + ' rejects Windows roots before accessing inputs or outputs', () => {
  win32Probe(`${noAccess}
    for (const selected of ${JSON.stringify(roots)}) {
      await assert.rejects(async () => ${call}, ${expected}, selected);
      assert.deepEqual(accesses, [], selected);
    }
  `);
});

test('dispatch APIs and CLI reject UNC share roots before reading payloads or observing locks', () => {
  const roots = ['\\\\server\\ledger.json', '\\\\server\\ledger.json\\', '//server/ledger.json',
    '//server/ledger.json/', '\\\\?\\UNC\\server\\ledger.json', '\\\\?\\UNC\\server\\ledger.json\\'];
  win32Probe(`${noAccess}
    for (const selected of ${JSON.stringify(roots)}) {
      await assert.rejects(registerDispatch(selected, spec), { code: 'DISPATCH_INPUT' }, selected);
      await assert.rejects(diagnoseDispatch(selected), { code: 'DISPATCH_INPUT' }, selected);
      for (const action of ['register', 'diagnose']) {
        const args = action === 'register' ? [action, selected, 'C:\\\\private\\\\payload.json'] : [action, selected];
        await assert.rejects(dispatchCli(args), { code: 'DISPATCH_INPUT', stage: 'cli_arguments',
          reason: action + '_ledger_path_invalid' }, selected);
      }
      assert.deepEqual(accesses, [], selected);
    }
  `);
});

test('Windows child paths keep their selected output and ledger names', () => {
  const paths = [
    ['C:\\private\\output', 'C:\\private', 'C:\\private', 'C:\\private\\output'],
    ['\\\\server\\share\\output', '\\\\server\\share\\', '\\\\server\\share\\', '\\\\server\\share\\output'],
    ['//server/share/output', '//server/share/', '\\\\server\\share\\', '\\\\server\\share\\output'],
    ['\\\\?\\C:\\private\\output', '\\\\?\\C:\\private', '\\\\?\\C:\\private', '\\\\?\\C:\\private\\output'],
    ['\\\\?\\UNC\\server\\share\\output', '\\\\?\\UNC\\server\\share', '\\\\?\\UNC\\server\\share', '\\\\?\\UNC\\server\\share\\output'],
  ];
  win32Probe(`
    const stopped = Error('stop before creation'), missing = () => Object.assign(Error('fixture missing'), { code: 'ENOENT' });
    const directory = { dev: 1n, ino: 2n, isDirectory: () => true, isSymbolicLink: () => false };
    for (const [selected, parent, canonical, expected] of ${JSON.stringify(paths)}) {
      let created = [], observed = [];
      fs.realpathSync.native = (file, options) => {
        assert.equal(file, parent);
        return options?.encoding === 'buffer' ? Buffer.from(canonical) : canonical;
      };
      fs.lstatSync = file => {
        observed.push(file);
        if (file === parent || file === canonical) return directory;
        throw missing();
      };
      fs.mkdirSync = file => { created.push(file); throw stopped; };
      fs.openSync = file => { created.push(file); throw stopped; };
      syncBuiltinESMExports();
      for (const call of [() => saveReviewedResult(review, selected), () => saveHandoffPacket(packet, selected),
        () => prepareVerification('text', selected, 'pro')]) {
        created = [];
        await assert.rejects(async () => call());
        assert.deepEqual(created, [expected], selected);
      }
      created = [];
      await assert.rejects(registerDispatch(selected + '.json', spec));
      assert.deepEqual(created, [expected + '.json.dispatch.lock'], selected);
      observed = [];
      const diagnostic = await diagnoseDispatch(selected + '.json');
      assert.equal(diagnostic.readOnly, true);
      assert.ok(observed.includes(expected + '.json'));
      assert.ok(observed.includes(expected + '.json.dispatch.lock'));
      assert.ok(observed.every(file => file === expected + '.json' || file === expected + '.json.dispatch.lock'));
    }
  `);
});

test('offline export readers still verify packages located at UNC share roots', () => {
  const shares = ['\\\\server\\share', '\\\\?\\UNC\\server\\share'];
  win32Probe(`
    for (const share of ${JSON.stringify(shares)}) {
      const mapped = file => {
        const relative = path.relative(share, file);
        assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), file);
        assert.ok(files.has(relative), file);
        return files.get(relative);
      };
      fs.lstatSync = (file, ...args) => nativeFs.lstatSync(mapped(file), ...args);
      fs.openSync = (file, ...args) => nativeFs.openSync(mapped(file), ...args);
      fs.realpathSync.native = file => { assert.equal(mapped(file), directory); return share; };
      syncBuiltinESMExports();
      for (const selected of [share, share + '\\\\']) {
        const page = readSavedResult(selected, pin);
        assert.equal(page.content, content); assert.equal(page.integrity, 'verified');
        assert.equal(exportReadCli([selected, '--task-id', pin.taskId, '--expected-sha256', pin.expectedSha256]).content, content);
      }
    }
  `, `
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'webgpt-unc-reader-')));
    cleanup = () => fs.rmSync(base, { recursive: true, force: true });
    const hostJoin = path.join, directory = hostJoin(base, 'export');
    saveReviewedResult(review, directory);
    const files = new Map([['', directory], ...fs.readdirSync(directory).map(name => [name, hostJoin(directory, name)])]);
  `);
});
