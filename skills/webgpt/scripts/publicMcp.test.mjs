import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './worker.mjs';

test('public MCP requires a persistent route capability and separate task authorization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgpt-public-test-'));
  let service = await start({ dir, port:0, controlPort:0, publicMcp:true });
  try {
    const key = readFileSync(join(dir, 'mcp-path.key'), 'utf8');
    assert.match(key, /^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'mcp-path.key')).mode & 0o777, 0o600);
    const send = (path, message, headers={}) => fetch(`http://127.0.0.1:${service.mcpPort}${path}`, {
      method:'POST', headers, body:JSON.stringify(message),
    });
    const init = { jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:'2025-03-26'} };
    for (const path of ['/mcp', '/mcp/'+'0'.repeat(64), '/status', '/register', '/mcp/'+key+'?extra=1']) {
      const response = await send(path, init);
      assert.equal(response.status, 404);
      assert.ok(!(await response.text()).includes(key));
    }
    assert.equal((await send('/mcp/'+key, init, {origin:'https://untrusted.example'})).status, 403);
    assert.equal((await send('/mcp/'+key, null)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${service.mcpPort}/mcp/${key}`)).status, 405);
    assert.equal((await (await send('/mcp/'+key, init)).json()).result.protocolVersion, '2025-03-26');
    const call = args => send('/mcp/'+key, {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_task',arguments:args}});
    assert.equal((await (await call({token:'wrong'})).json()).result.isError, true);
    const registered = await (await fetch(`http://127.0.0.1:${service.controlPort}/register`, {
      method:'POST', headers:{authorization:'Bearer '+service.key},
      body:JSON.stringify({id:'probe',instructions:'Review',inputs:{}}),
    })).json();
    assert.equal((await (await call({token:registered.token})).json()).result.structuredContent.id, 'probe');
    await service.close();
    service = await start({dir,port:0,controlPort:0,publicMcp:true});
    assert.equal(readFileSync(join(dir,'mcp-path.key'),'utf8'), key);
    assert.equal((await (await call({token:registered.token})).json()).result.structuredContent.id, 'probe');
  } finally { await service.close(); rmSync(dir,{recursive:true}); }
});

test('an invalid saved public route key fails closed and releases the startup lock', async () => {
  const dir = mkdtempSync(join(tmpdir(),'webgpt-public-invalid-'));
  try {
    writeFileSync(join(dir,'mcp-path.key'),'short');
    await assert.rejects(start({dir,port:0,controlPort:0,publicMcp:true}), /invalid mcp-path.key/);
    await assert.rejects(start({dir,port:0,controlPort:0,publicMcp:true}), /invalid mcp-path.key/);
  } finally { rmSync(dir,{recursive:true}); }
});
