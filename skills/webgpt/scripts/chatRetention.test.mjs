import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';
import { request } from './client.mjs';

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8');
const documents = ['../SKILL.md', '../references/setup.md', '../references/workspace.md'];

test('installed skill documents retain task chats by default and require explicit deletion requests', () => {
  for (const file of documents) {
    const text = read(file).replace(/\s+/g, ' ');
    assert.match(text, /retain task chats by default/i, file);
    assert.match(text, /Delete a chat only when the user explicitly requests deletion/i, file);
    assert.doesNotMatch(text, /Workflow requests include permanent deletion|permanently delete its test chats|acknowledges and deletes that task chat|Delete the finished probe chat|delete task chats per SKILL\.md/i, file);
  }
});

test('retained chats are a completed cleanup path while tab and token cleanup stay independent', () => {
  const skill = read('../SKILL.md').replace(/\s+/g, ' ');
  assert.match(skill, /PENDING → CHAT_RETAINED → DONE/);
  assert.match(skill, /Retaining a chat is successful cleanup, not a blocker/);
  assert.match(skill, /including setup tests, failed tasks and recovery chats/);
  assert.match(skill, /Keep their URLs in the private ledger/);
  assert.match(skill, /retained chats must not keep task tokens or backup checks active/);
  assert.match(skill, /Close the exact terminal task-owned tabs after collection/);
  assert.match(skill, /Never open deletion controls on the default retention path/);
});

test('installation instructions select this fork instead of silently restoring upstream defaults', () => {
  assert.match(read('../references/setup.md'), /Install `skills\/webgpt` from `22nsuk\/WebGPT`/);
});

test('MCP initialization communicates chat retention without changing completion and revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-chat-retention-'));
  let service;
  let clock = 1000;
  try {
    service = await start({ dir, port: 0, controlPort: 0, now: () => clock });
    const config = { dataDir: dir, controlPort: service.controlPort };
    const rpc = async (method, params) => {
      const response = await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`, {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const initialized = await rpc('initialize', { protocolVersion: '2025-03-26' });
    assert.match(initialized.instructions, /retains task chats by default/);
    assert.match(initialized.instructions, /only when the user explicitly requests deletion/);
    assert.doesNotMatch(initialized.instructions, /deletes the chat after collection/);
    for (const status of ['completed', 'failed', 'cancelled']) {
      const { token } = await request('register', { id: status, instructions: 'Retain this chat.', inputs: {} }, config);
      const result = await rpc('tools/call', { name: 'submit_result', arguments: {
        token, status, summary: status, result: `Saved ${status} evidence`,
      } });
      assert.equal(result.isError, false);
      const notice = await request('status', undefined, config);
      assert.equal(notice.events.length, 1);
      assert.deepEqual(notice.backupDue, []);
      const artifact = notice.events[0].artifact;
      await request('ack', { id: status }, config);
      assert.equal((await rpc('tools/call', { name: 'get_task', arguments: { token } })).isError, true);
      clock += 900000;
      assert.deepEqual(await request('wait', undefined, config), { events: [], backupDue: [] });
      assert.equal(readFileSync(artifact, 'utf8'), `Saved ${status} evidence`);
    }
  } finally {
    if (service) await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
