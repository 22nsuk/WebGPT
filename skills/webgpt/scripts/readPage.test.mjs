// Character pages exercise the real MCP envelope and whole-source checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { request } from './client.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';
import { observeFileRead } from './test-fixtures/file-read.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');

async function fixture(t, { source = 'A😀\r\nB', inputs = { supplied: source, empty: '' } } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), 'webgpt-read-page-')));
  const dir = join(base, 'runtime'), root = join(base, 'project'); fs.mkdirSync(root);
  const file = join(root, 'owned.txt'); fs.writeFileSync(file, source);
  let worker;
  t.after(async () => { await worker?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  worker = await start({ dir, port: 0, controlPort: 0, configFile: join(base, 'config.json'), waitMs: 20, closeGraceMs: 50 });
  const config = { dataDir: dir, controlPort: worker.controlPort };
  const { token } = await request('register', { id: 'owned', instructions: 'Read the fixture', inputs,
    workspace: { root, mode: 'read' } }, config);
  // Unlike callTool, this transport retains the actual wire and caller's ID.
  const rpc = async (method, params, id = 1) => {
    const response = await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const wire = await response.text(), parsed = JSON.parse(wire);
    assert.equal(parsed.error, undefined); assert.equal(parsed.id, id);
    return { wire, result: parsed.result };
  };
  const call = (name, args, id) => rpc('tools/call', { name, arguments: { token, ...args } }, id);
  return { worker, dir, root, file, config, token, rpc, call, state: () => fs.readFileSync(join(dir, 'state.json')) };
}

function value(reply, format = 'dual') {
  assert.equal(reply.result.isError, false, reply.result.content[0].text);
  assert.ok(reply.wire.length + 2 <= 20000, `JSON-RPC response exceeds the page allowance: ${reply.wire.length + 2}`);
  const result = JSON.parse(reply.result.content[0].text);
  if (format === 'dual') assert.deepEqual(reply.result.structuredContent, result);
  else assert.equal(Object.hasOwn(reply.result, 'structuredContent'), false);
  return result;
}
function failure(reply, pattern) {
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent, undefined);
  if (pattern) assert.match(reply.result.content[0].text, pattern);
}
function pageValue(reply, source, offset, format = 'dual') {
  const page = value(reply, format);
  assert.equal(page.charUnit, 'UTF-16'); assert.equal(page.startCharOffset, offset);
  assert.equal(page.totalChars, source.length); assert.equal(page.sha256, digest(source));
  assert.ok(Number.isSafeInteger(page.endCharOffset));
  assert.ok(page.endCharOffset <= source.length);
  assert.ok(source.length ? page.endCharOffset > offset : page.endCharOffset === 0);
  assert.equal(page.text, source.slice(offset, page.endCharOffset));
  assert.equal(page.text.isWellFormed(), true);
  assert.equal(source.slice(page.endCharOffset - 1, page.endCharOffset + 1) === '\r\n', false,
    'a page must not split CRLF');
  assert.equal(page.nextCharOffset, page.endCharOffset < source.length ? page.endCharOffset : null);
  assert.equal(page.partial, offset !== 0 || page.endCharOffset < source.length);
  for (const key of ['nextOffset', 'startOffset', 'endOffset', 'startLine', 'endLine', 'totalLines', 'content'])
    assert.equal(Object.hasOwn(page, key), false, `character pages must not expose ${key}`);
  return page;
}
async function reconstruct(f, name, selector, source, responseFormat, id = 1) {
  let offset = 0, assembled = '', count = 0;
  do {
    // Bound the harness if a regression makes these modest fixtures crawl.
    assert.ok(++count <= 100, 'the fixture did not finish within 100 pages');
    const page = pageValue(await f.call(name, { ...selector, charOffset: offset, responseFormat }, id), source, offset, responseFormat);
    if (name === 'read_file') { assert.equal(page.path, selector.path); assert.equal(page.exists, true); assert.equal(typeof page.mode, 'number'); }
    else assert.equal(page.name, selector.name);
    assembled += page.text; offset = page.nextCharOffset;
  } while (offset !== null);
  assert.equal(assembled, source); assert.ok(count > 1);
}

test('only the two MCP read tools advertise optional UTF-16 character offsets', async t => {
  const f = await fixture(t), { result } = await f.rpc('tools/list', {});
  assert.equal(result.tools.length, 7);
  for (const tool of result.tools) {
    if (['read_file', 'read_input'].includes(tool.name)) {
      assert.deepEqual(tool.inputSchema.properties.charOffset, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
      assert.equal(tool.inputSchema.required.includes('charOffset'), false);
    } else assert.equal(tool.inputSchema.properties.charOffset, undefined);
  }
});

for (const [name, selector, format] of [
  ['read_file', { path: 'owned.txt' }, 'dual'], ['read_input', { name: 'supplied' }, 'text'],
]) test(`${name} reconstructs a 200001-character single line within the actual ${format} response budget`, async t => {
  const source = 'x'.repeat(200001), f = await fixture(t, { source }), before = f.state();
  await reconstruct(f, name, selector, source, format);
  assert.deepEqual(f.state(), before); assert.equal(fs.readFileSync(f.file, 'utf8'), source);
});

test('both MCP formats page escaped inputs with Unicode, BOM, NUL, CRLF and a long escaped request ID', async t => {
  const source = '\ufeff한국어 😀\r\n"\\\t\0마지막\r끝\n'.repeat(1600), id = '\0'.repeat(1024);
  const f = await fixture(t, { inputs: { supplied: source } }), before = f.state();
  for (const format of ['dual', 'text']) await reconstruct(f, 'read_input', { name: 'supplied' }, source, format, id);
  assert.deepEqual(f.state(), before);
});

test('a complete emoji fits a tight MCP page even when its escaped half would not', async t => {
  const source = '😀abcd';
  // Each name leaves exactly enough room for the first complete code point.
  const cases = [
    { responseFormat: 'text', name: 't'.repeat(19677) },
    { responseFormat: 'dual', name: 'd'.repeat(9725) },
  ];
  const f = await fixture(t, { inputs: Object.fromEntries(cases.map(({ name }) => [name, source])) });
  const before = f.state();
  for (const { responseFormat, name } of cases) {
    const reply = await f.call('read_input', { name, charOffset: 0, responseFormat }, 1);
    const page = pageValue(reply, source, 0, responseFormat);
    assert.equal(page.name, name);
    assert.equal(page.text, '😀');
    assert.equal(page.endCharOffset, 2);
    assert.equal(page.nextCharOffset, 2);
    assert.equal(reply.wire.length + 2, 20000);
  }
  assert.deepEqual(f.state(), before);
});

test('character cursors preserve Unicode and CRLF boundaries and reject nonempty EOF', async t => {
  const source = '\ufeffA😀\r\nB', f = await fixture(t, { source });
  for (const [name, selector] of [['read_file', { path: 'owned.txt' }], ['read_input', { name: 'supplied' }]]) {
    for (const charOffset of [3, 5, source.length, source.length + 1, Number.MAX_SAFE_INTEGER])
      failure(await f.call(name, { ...selector, charOffset }), /invalid text page offset/);
    for (const charOffset of [2, 4, 6]) pageValue(await f.call(name, { ...selector, charOffset }), source, charOffset);
  }
});

test('empty pages finish at zero and missing files retain their original shape', async t => {
  const f = await fixture(t); fs.writeFileSync(join(f.root, 'empty.txt'), '');
  for (const [name, selector] of [['read_file', { path: 'empty.txt' }], ['read_input', { name: 'empty' }]]) {
    const page = pageValue(await f.call(name, { ...selector, charOffset: 0 }), '', 0);
    assert.equal(page.nextCharOffset, null); assert.equal(page.partial, false);
    failure(await f.call(name, { ...selector, charOffset: 1 }), /invalid text page offset/);
  }
  assert.deepEqual(value(await f.call('read_file', { path: 'absent.txt', charOffset: 0 })),
    { path: 'absent.txt', exists: false, text: null, sha256: null });
  failure(await f.call('read_file', { path: 'absent.txt', charOffset: 0, expectedSha256: '0'.repeat(64) }), /revision conflict/);
});

test('invalid character arguments and mixed line options fail before file content is read', async t => {
  const f = await fixture(t), before = f.state(), observed = observeFileRead(t, f.file);
  try {
    for (const charOffset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null])
      failure(await f.call('read_file', { path: 'owned.txt', charOffset }));
    for (const [name, selector] of [['read_file', { path: 'owned.txt' }], ['read_input', { name: 'supplied' }]]) {
      for (const options of [{ offset: 1 }, { limit: 1 }, { maxChars: 200000 }])
        failure(await f.call(name, { ...selector, charOffset: 0, ...options }), /cannot be combined/);
    }
  } finally { observed.restore(); }
  assert.equal(observed.evidence.opens, 0); assert.equal(observed.evidence.bytes, 0);
  assert.deepEqual(f.state(), before);
});

test('oversized input metadata fails explicitly for nonempty and empty pages', async t => {
  const longName = 'n'.repeat(21000), emptyName = 'e'.repeat(21000);
  const f = await fixture(t, { inputs: { [longName]: 'x', [emptyName]: '' } }), before = f.state();
  for (const [name, responseFormat] of [[longName, 'dual'], [longName, 'text'], [emptyName, 'text']])
    failure(await f.call('read_input', { name, charOffset: 0, responseFormat }), /text page metadata exceeds output limit/);
  assert.deepEqual(f.state(), before);
});

test('file pages read and pin the whole revision and reject corruption outside the returned page', async t => {
  const source = 'a'.repeat(30000), f = await fixture(t, { source }), before = f.state();
  const observed = observeFileRead(t, f.file); let first;
  try { first = pageValue(await f.call('read_file', { path: 'owned.txt', charOffset: 0 }), source, 0); }
  finally { observed.restore(); }
  assert.equal(observed.evidence.bytes, Buffer.byteLength(source));
  assert.equal(observed.evidence.opens, 1); assert.equal(observed.evidence.closes, 1);
  assert.ok(first.endCharOffset < source.length - 1);
  const changed = source.slice(0, -1) + 'b'; fs.writeFileSync(f.file, changed);
  failure(await f.call('read_file', { path: 'owned.txt', charOffset: first.nextCharOffset, expectedSha256: first.sha256 }), /revision conflict/);
  const fresh = pageValue(await f.call('read_file', { path: 'owned.txt', charOffset: 0, expectedSha256: digest(changed) }), changed, 0);
  assert.equal(fresh.text, first.text); assert.notEqual(fresh.sha256, first.sha256);
  const invalid = Buffer.from(source); invalid[invalid.length - 1] = 0xff; fs.writeFileSync(f.file, invalid);
  failure(await f.call('read_file', { path: 'owned.txt', charOffset: 0 }), /UTF-8/);
  invalid[invalid.length - 1] = 0; fs.writeFileSync(f.file, invalid);
  failure(await f.call('read_file', { path: 'owned.txt', charOffset: 0 }), /UTF-8 text file required/);
  assert.deepEqual(f.state(), before); assert.deepEqual(fs.readFileSync(f.file), invalid);
});

test('character pages retain token, workspace and terminal collection boundaries', async t => {
  const source = 'retained input', f = await fixture(t, { source });
  const other = await request('register', { id: 'other', instructions: 'Only supplied inputs', inputs: { supplied: 'other input' } }, f.config);
  const before = f.state();
  failure(await f.call('read_file', { path: 'owned.txt', charOffset: 0, token: 'wrong' }), /unknown task token/);
  failure(await f.call('read_input', { name: 'supplied', charOffset: 0, token: 'wrong' }), /unknown task token/);
  failure(await f.call('read_file', { path: 'owned.txt', charOffset: 0, token: other.token }));
  pageValue(await f.call('read_input', { name: 'supplied', charOffset: 0, token: other.token }), 'other input', 0);
  pageValue(await f.call('read_file', { path: 'owned.txt', charOffset: 0 }), source, 0);
  assert.equal((await callTool(f.worker, 'write_file', { token: f.token, path: 'owned.txt', text: 'forbidden', expectedSha256: digest(source) })).isError, true);
  assert.deepEqual(f.state(), before); assert.equal(fs.readFileSync(f.file, 'utf8'), source);
  assert.equal((await callTool(f.worker, 'submit_result', { token: f.token, status: 'completed', summary: 'done', result: 'reviewed' })).isError, false);
  const completed = f.state();
  failure(await f.call('read_file', { path: 'owned.txt', charOffset: 0 }), /terminal/);
  pageValue(await f.call('read_input', { name: 'supplied', charOffset: 0 }), source, 0);
  assert.deepEqual(f.state(), completed);
  await request('collect', { id: 'owned', expectedStatus: 'completed', expectedSha256: digest('reviewed') }, f.config);
  const collected = f.state();
  for (const [name, selector] of [['read_file', { path: 'owned.txt' }], ['read_input', { name: 'supplied' }]])
    failure(await f.call(name, { ...selector, charOffset: 0 }), /unknown task token/);
  assert.deepEqual(f.state(), collected); assert.equal(fs.readFileSync(f.file, 'utf8'), source);
});

test('later character pages recheck persisted state before returning any source', async t => {
  const source = 'x'.repeat(20001), f = await fixture(t, { source });
  const filePage = pageValue(await f.call('read_file', { path: 'owned.txt', charOffset: 0 }), source, 0);
  const inputPage = pageValue(await f.call('read_input', { name: 'supplied', charOffset: 0 }), source, 0);
  fs.writeFileSync(join(f.dir, 'state.json'), 'invalid fixture state');
  const before = f.state(), observed = observeFileRead(t, f.file);
  try {
    failure(await f.call('read_file', { path: 'owned.txt', charOffset: filePage.nextCharOffset }));
    failure(await f.call('read_input', { name: 'supplied', charOffset: inputPage.nextCharOffset }));
  } finally { observed.restore(); }
  assert.equal(observed.evidence.opens, 0); assert.equal(observed.evidence.bytes, 0);
  assert.deepEqual(f.state(), before); assert.equal(fs.readFileSync(f.file, 'utf8'), source);
});
