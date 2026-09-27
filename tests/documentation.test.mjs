import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const refs = 'skills/webgpt/references/';
const documents = ['README.md', 'README.ko.md', refs + 'install-manual.md',
  refs + 'install-manual.ko.md', refs + 'upstream-review-2026-09-28.md'];
const normalizeNewlines = text => text.replace(/\r\n/g, '\n');
const read = path => normalizeNewlines(readFileSync(join(root, path), 'utf8'));
// A deliberately small checker for these authored Markdown files, not a general renderer.
const prose = text => normalizeNewlines(text).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
function anchors(text) {
  const result = new Set(), counts = new Map();
  for (const match of prose(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = match[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.add(base + (count ? '-' + count : ''));
  }
  for (const match of text.matchAll(/<a\s+id=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}
function localLinks(text) {
  return [...prose(text).matchAll(/\]\(([^\s)]+)\)/g)].map(match => match[1])
    .filter(target => !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target));
}
function checkLink(base, file, link) {
  const [path, fragment] = link.split('#');
  const target = resolve(dirname(join(base, file)), decodeURIComponent(path || ''));
  const resolved = path ? target : join(base, file);
  const rel = relative(base, resolved);
  assert.ok(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), 'link escapes documentation boundary: ' + link);
  assert.ok(existsSync(resolved), 'missing local link: ' + file + ' -> ' + link);
  if (fragment) assert.ok(anchors(readFileSync(resolved, 'utf8')).has(decodeURIComponent(fragment)),
    'missing anchor: ' + file + ' -> ' + link);
}
function recipes(text) {
  text = normalizeNewlines(text);
  const result = {};
  for (const match of text.matchAll(/<!-- recipe:([a-z-]+) -->\n```([^\n]*)\n([\s\S]*?)\n```/g)) {
    assert.ok(!Object.hasOwn(result, match[1]), 'duplicate recipe: ' + match[1]);
    result[match[1]] = { language: match[2], body: match[3] };
  }
  assert.ok(Object.keys(result).length, 'no installation recipes');
  assert.equal(Object.keys(result).length, [...text.matchAll(/^```[^\n]+$/gm)].length,
    'every executable/example fence must have a recipe marker');
  return result;
}

test('documentation links resolve to real files and anchors', () => {
  for (const file of documents) for (const link of localLinks(read(file))) checkLink(root, file, link);
});

test('installed guides do not require the surrounding repository', () => {
  const skill = join(root, 'skills/webgpt');
  for (const file of documents.filter(file => file.startsWith(refs))) {
    for (const link of localLinks(read(file))) checkLink(skill, relative(skill, join(root, file)), link);
  }
});

test('manual translations contain identical complete recipes', () => {
  const english = recipes(read(refs + 'install-manual.md'));
  const korean = recipes(read(refs + 'install-manual.ko.md'));
  assert.deepEqual(korean, english);
  for (const id of ['copy-posix', 'copy-windows', 'config-posix', 'config-windows',
    'worker', 'checks', 'installed-tests-posix', 'installed-tests-windows', 'forward', 'probe-register', 'probe-collect']) {
    assert.ok(english[id], 'missing recipe ' + id);
  }
});

test('manual configuration examples match runtime defaults', async () => {
  const { configuration } = await import('../skills/webgpt/scripts/client.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'webgpt-doc-config-'));
  try {
    for (const file of ['install-manual.md', 'install-manual.ko.md']) {
      const content = recipes(read(refs + file))['config-example'].body;
      assert.deepEqual(JSON.parse(content), { publicMcp: true });
      const path = join(directory, file + '.json');
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
      // Explicit fixture avoids consulting the user's live configuration or environment.
      const config = configuration({ WEBGPT_CONFIG: path });
      assert.equal(config.publicMcp, true);
      assert.equal(config.mcpPort, 43137);
      assert.equal(config.controlPort, 43139);
      assert.ok(isAbsolute(config.dataDir));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('manual recipes use the supported registration and lifecycle commands', () => {
  for (const file of ['install-manual.md', 'install-manual.ko.md']) {
    const examples = recipes(read(refs + file));
    assert.match(examples['probe-register'].body, /client\.mjs" register "\$HOME\//);
    // --file is accepted by selected task commands, not by register in this fork.
    assert.doesNotMatch(examples['probe-register'].body, /register\s+--/);
    assert.match(examples.checks.body, /dispatch preflight/);
    assert.match(examples['probe-collect'].body, /collect --resume <task-id>/);
    assert.doesNotMatch(examples['probe-collect'].body, /client\.mjs ack\b/);
    assert.match(examples.forward.body, /--url http:\/\/127\.0\.0\.1:43137$/);
    assert.match(examples['copy-posix'].body, /checkout --detach "\$REVISION"/);
    assert.match(examples['copy-windows'].body, /checkout --detach \$Revision/);
  }
});

test('readme navigation exposes both installation routes and languages', () => {
  for (const [file, other, manual] of [['README.md', 'README.ko.md', 'install-manual.md'],
    ['README.ko.md', 'README.md', 'install-manual.ko.md']]) {
    const links = localLinks(read(file));
    assert.ok(links.includes(other));
    assert.ok(links.includes(refs + manual));
    assert.ok(links.includes(refs + 'setup.md'));
    assert.ok(links.includes(refs + 'upstream-review-2026-09-28.md'));
  }
});

test('documentation checks reject broken links anchors and recipe fixtures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'webgpt-doc-links-'));
  try {
    writeFileSync(join(directory, 'guide.md'), '# Guide\n## 설치\n## 설치\n<a id="stable"></a>\n');
    for (const link of ['guide.md#설치', '#설치-1', '#stable']) checkLink(directory, 'guide.md', link);
    assert.throws(() => checkLink(directory, 'guide.md', 'missing.md'), /missing local link/);
    assert.throws(() => checkLink(directory, 'guide.md', '#absent'), /missing anchor/);
    assert.throws(() => checkLink(directory, 'guide.md', '../outside.md'), /escapes/);
    const sample = '<!-- recipe:one -->\n```sh\nnode --version\n```\n';
    assert.deepEqual(recipes(sample).one, { language: 'sh', body: 'node --version' });
    const crlf = text => text.replace(/\n/g, '\r\n');
    assert.deepEqual(recipes(crlf(sample)), recipes(sample));
    const headings = '# Guide\n## 설치\n## 설치\n';
    assert.deepEqual(anchors(crlf(headings)), anchors(headings));
    const fencedLink = '```text\n[example](not-a-link.md)\n```\n[real](guide.md)\n';
    assert.deepEqual(localLinks(crlf(fencedLink)), ['guide.md']);
    assert.throws(() => recipes(sample + sample), /duplicate recipe/);
    assert.throws(() => recipes(sample + '```sh\nnode other.mjs\n```\n'), /recipe marker/);
    assert.deepEqual(localLinks('```text\n[example](not-a-link.md)\n```\n[real](guide.md)\n'), ['guide.md']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('POSIX configuration recipe refuses overrides and preserves existing data', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'webgpt-doc-recipe-'));
  const body = recipes(read(refs + 'install-manual.md'))['config-posix'].body;
  const env = { ...process.env, HOME: directory };
  delete env.WEBGPT_CONFIG;
  delete env.WEBGPT_DATA_DIR;
  const run = overrides => spawnSync('sh', [], { input: body, encoding: 'utf8', env: { ...env, ...overrides }, timeout: 10000 });
  try {
    for (const overrides of [{ WEBGPT_CONFIG: '/existing-config.json' },
      { WEBGPT_DATA_DIR: '/existing-runtime' }, { WEBGPT_CONFIG: '' }, { WEBGPT_DATA_DIR: '' }]) {
      const result = run(overrides);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1, 'an override must stop the fresh-install recipe');
      assert.equal(existsSync(join(directory, '.config/webgpt')), false);
      assert.equal(existsSync(join(directory, '.local/share/webgpt')), false);
    }
    const first = run({});
    assert.equal(first.error, undefined);
    assert.equal(first.status, 0, first.stderr);
    const config = join(directory, '.config/webgpt/config.json');
    const bytes = readFileSync(config);
    assert.deepEqual(JSON.parse(bytes.toString()), { publicMcp: true });
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(config)).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, '.local/share/webgpt')).mode & 0o777, 0o700);
    const second = run({});
    assert.equal(second.error, undefined);
    assert.equal(second.status, 1, 'a repeated installation must not overwrite state');
    assert.deepEqual(readFileSync(config), bytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
