import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const data = result => {
  assert.equal(result.isError, false, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
};
const rejected = (result, pattern) => {
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, pattern);
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'webgpt-guidance-'));
  const dir = join(root, 'runtime'), project = join(root, 'plain-folder');
  let service;
  t.after(async () => {
    if (service) await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(project);
  writeFileSync(join(project, 'note.txt'), 'Original note.\n');
  service = await start({ dir, port: 0, controlPort: 0, configFile: join(root, 'private-config.json') });
  let id = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.error, undefined);
    return message.result;
  };
  const control = async (method, body) => {
    const response = await fetch(`http://127.0.0.1:${service.controlPort}/${method}`, {
      method: 'POST', headers: { authorization: 'Bearer ' + service.key }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  return { root, dir, project, rpc, control, call };
}

test('initialize delivers scope-limited general-task guidance without task data or state changes', async t => {
  const f = await fixture(t);
  const { token } = await f.control('register', {
    id: 'private-task', instructions: 'Review only: private instruction sentinel.',
    inputs: { privateInput: 'private input sentinel' },
  });
  const before = readFileSync(join(f.dir, 'state.json'));
  let previous;
  for (const protocolVersion of ['2025-03-26', '2025-06-18']) {
    const initialized = await f.rpc('initialize', { protocolVersion, capabilities: {},
      clientInfo: { name: 'guidance-test', version: '1' } });
    assert.equal(initialized.protocolVersion, protocolVersion);
    assert.deepEqual(initialized.capabilities, { tools: {} });
    const text = initialized.instructions;
    assert.match(text, /This MCP bridge provides no Git, PR, shell/);
    assert.doesNotMatch(text, /(?:^|\. )No Git, PR, shell/);
    assert.match(text, /Separately available tools may be used only when authorized/);
    assert.match(text, /Git is not required/);
    assert.match(text, /checks, corrections and delivery before submit_result/);
    assert.match(text, /requested review, plan or draft stays within that scope/);
    assert.match(text, /read-only grants cannot write/);
    assert.match(text, /does not prove binary delivery or local placement/);
    assert.match(text, /smallest remaining parent action/);
    assert.match(text, /stop assigned changes and finish the final chat answer/);
    assert.match(text, /retains task chats by default/);
    assert.match(text, /only when the user explicitly requests deletion/);
    for (const secret of [token, f.root, 'private instruction sentinel', 'private input sentinel'])
      assert.ok(!text.includes(secret), 'connection instructions must not expose task data');
    if (previous !== undefined) assert.equal(text, previous);
    previous = text;
  }
  assert.deepEqual(readFileSync(join(f.dir, 'state.json')), before);
});

test('the seven-tool inventory explains terminal text submission without adding execution or binary APIs', async t => {
  const f = await fixture(t);
  const { tools } = await f.rpc('tools/list');
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'delete_file', 'get_task', 'list_files', 'read_file', 'read_input', 'submit_result', 'write_file',
  ]);
  const submit = tools.find(tool => tool.name === 'submit_result');
  assert.match(submit.description, /after feasible in-scope work and checks/);
  assert.match(submit.description, /Text submission does not transfer binary files/);
  assert.match(submit.description, /stop assigned changes and finish the final chat answer/);
  assert.deepEqual(submit.inputSchema.required, ['token', 'status', 'summary', 'result']);
  assert.deepEqual(Object.keys(submit.inputSchema.properties), ['token', 'status', 'summary', 'result']);
  assert.deepEqual(submit.inputSchema.properties.status.enum, ['completed', 'failed', 'cancelled']);
  assert.equal(submit.inputSchema.additionalProperties, false);
});

test('input-only work keeps its exact assignment and needs neither a workspace nor Git to complete', async t => {
  const f = await fixture(t);
  const instructions = 'Translate the input into Korean; do not edit files or send it elsewhere.';
  const { token } = await f.control('register', { id: 'translation', instructions, inputs: { source: 'Hello.' } });
  assert.deepEqual(data(await f.call('get_task', { token })), {
    id: 'translation', instructions, inputs: ['source'], status: 'running', workspace: null, changes: [], recoveryRequired: [],
  });
  assert.deepEqual(data(await f.call('read_input', { token, name: 'source' })), { name: 'source', text: 'Hello.' });
  rejected(await f.call('read_file', { token, path: 'note.txt' }), /workspace absent/);
  rejected(await f.call('write_file', { token, path: 'output.txt', expectedSha256: null, text: 'not permitted' }), /workspace absent/);
  const result = '안녕하세요.';
  const receipt = data(await f.call('submit_result', { token, status: 'completed', summary: 'Translated.', result }));
  assert.equal(receipt.sha256, hash(result));
  assert.equal(readFileSync(join(f.dir, 'translation.result.txt'), 'utf8'), result);
  await f.control('collect', { id: 'translation', expectedStatus: 'completed', expectedSha256: receipt.sha256 });
  rejected(await f.call('get_task', { token }), /unknown task token/);
  rejected(await f.call('read_input', { token, name: 'source' }), /unknown task token/);
  assert.equal(existsSync(join(f.project, 'output.txt')), false);
});

test('non-Git folder work still enforces grants, conflicts, binary rejection and terminal file closure', async t => {
  const f = await fixture(t);
  assert.equal(existsSync(join(f.project, '.git')), false);
  const { token: readToken } = await f.control('register', { id: 'review', instructions: 'Read only.', inputs: {},
    workspace: { root: f.project, mode: 'read' } });
  const original = data(await f.call('read_file', { token: readToken, path: 'note.txt' }));
  rejected(await f.call('write_file', { token: readToken, path: 'note.txt', expectedSha256: original.sha256, text: 'forbidden' }), /read-only/);
  rejected(await f.call('delete_file', { token: readToken, path: 'note.txt', expectedSha256: original.sha256 }), /read-only/);
  assert.equal(readFileSync(join(f.project, 'note.txt'), 'utf8'), original.text);

  const { token } = await f.control('register', { id: 'edit', instructions: 'Correct the note.', inputs: {},
    workspace: { root: f.project, mode: 'edit' } });
  const current = data(await f.call('read_file', { token, path: 'note.txt' }));
  const changed = data(await f.call('write_file', { token, path: 'note.txt', expectedSha256: current.sha256,
    oldText: 'Original', text: 'Corrected' }));
  assert.equal(changed.beforeSha256, current.sha256);
  assert.equal(readFileSync(changed.backup, 'utf8'), original.text);
  const final = data(await f.call('read_file', { token, path: 'note.txt', expectedSha256: changed.afterSha256 }));
  assert.equal(final.text, 'Corrected note.\n');
  rejected(await f.call('write_file', { token, path: 'note.txt', expectedSha256: current.sha256, text: 'stale' }), /revision conflict/);
  rejected(await f.call('write_file', { token, path: 'binary.bin', expectedSha256: null, text: '\0binary' }), /text must be/);
  assert.equal(existsSync(join(f.project, 'binary.bin')), false);
  const assignment = data(await f.call('get_task', { token }));
  assert.deepEqual(assignment.changes, [changed]);
  assert.deepEqual(assignment.recoveryRequired, []);

  const saved = data(await f.call('submit_result', { token, status: 'completed', summary: 'Note corrected.', result: final.text }));
  rejected(await f.call('write_file', { token, path: 'note.txt', expectedSha256: final.sha256, text: 'after submission' }), /task is terminal/);
  await f.control('collect', { id: 'edit', expectedStatus: 'completed', expectedSha256: saved.sha256 });
  rejected(await f.call('read_file', { token, path: 'note.txt' }), /unknown task token/);
  assert.equal(readFileSync(join(f.project, 'note.txt'), 'utf8'), final.text);
  assert.equal(existsSync(join(f.project, '.git')), false);
});
