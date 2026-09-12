import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantWorkspace, listWorkspace, readWorkspace, changeWorkspace } from './workspace.mjs';
import { start } from './worker.mjs';

const fixture = fn => {
  const dir=mkdtempSync(join(tmpdir(),'webgpt-files-'));
  const root=join(dir,'project');mkdirSync(root);
  const grant=grantWorkspace({root,mode:'edit'});
  return Promise.resolve().then(()=>fn({dir,root,grant})).finally(()=>rmSync(dir,{recursive:true}));
};
test('direct create/edit/delete preserves content, revisions and recoverable originals',()=>fixture(({dir,root,grant})=>{
  assert.equal(readWorkspace(grant,'new/fresh.txt').exists,false);
  const create=changeWorkspace(grant,dir,'task',{path:'source.txt',text:'first 한국어',expectedSha256:null});
  assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'first 한국어');
  const read=readWorkspace(grant,'source.txt');assert.equal(read.sha256,create.afterSha256);
  const edit=changeWorkspace(grant,dir,'task',{path:'source.txt',text:'second',expectedSha256:read.sha256});
  assert.equal(readFileSync(edit.backup,'utf8'),'first 한국어');
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'source.txt',text:'stale',expectedSha256:read.sha256}),/revision conflict/);
  const deleted=changeWorkspace(grant,dir,'task',{path:'source.txt',expectedSha256:edit.afterSha256},true);
  assert.equal(existsSync(join(root,'source.txt')),false);assert.equal(readFileSync(deleted.backup,'utf8'),'second');
  assert.equal(readWorkspace(grant,'source.txt').exists,false);
  changeWorkspace(grant,dir,'task',{path:'new/fresh.txt',text:'nested',expectedSha256:null});
  assert.equal(readFileSync(join(root,'new/fresh.txt'),'utf8'),'nested');
}));
test('scope, read-only, traversal, protected files, symlinks and hardlinks fail closed',()=>fixture(({dir,root,grant})=>{
  writeFileSync(join(root,'source.txt'),'safe');
  const readonly=grantWorkspace({root,mode:'read'});
  assert.equal(readWorkspace(readonly,'source.txt').text,'safe');
  for(const path of ['../outside','/etc/passwd','.git/config','new/../source.txt']) {
    assert.throws(()=>readWorkspace(grant,path));
    assert.throws(()=>changeWorkspace(grant,dir,'task',{path,text:'bad',expectedSha256:null}));
  }
  assert.throws(()=>changeWorkspace(readonly,dir,'task',{path:'source.txt',text:'bad',expectedSha256:null}),/read-only/);
  assert.throws(()=>grantWorkspace({root,mode:'read',read:[],write:['source.txt']}),/root and mode only/);
  assert.throws(()=>grantWorkspace({root:'/',mode:'edit'}),/project root/);
  writeFileSync(join(dir,'outside.txt'),'private');symlinkSync(join(dir,'outside.txt'),join(root,'alias.txt'));
  assert.throws(()=>readWorkspace(grant,'alias.txt'),/symlink/);
  symlinkSync(dir,join(root,'new'));
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'new/fresh.txt',text:'escape',expectedSha256:null}),/symlink/);
  assert.equal(existsSync(join(dir,'fresh.txt')),false);
  linkSync(join(root,'source.txt'),join(dir,'hard.txt'));
  assert.throws(()=>readWorkspace(grant,'source.txt'),/hardlink/);
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'source.txt',text:'bad'}),/expectedSha256/);
}));
test('binary and oversized files cannot be read or replaced',()=>fixture(({dir,root,grant})=>{
  writeFileSync(join(root,'source.txt'),Buffer.from([0xff,0x00]));
  assert.throws(()=>readWorkspace(grant,'source.txt'),/UTF-8/);
  writeFileSync(join(root,'source.txt'),'x'.repeat(1024*1024+1));
  assert.throws(()=>readWorkspace(grant,'source.txt'),/1 MiB/);
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'new/fresh.txt',text:'x'.repeat(1024*1024+1),expectedSha256:null}),/1 MiB/);
  assert.equal(existsSync(join(root,'new')),false);
}));
test('one project grant can discover and edit newly chosen files without per-file registration',()=>fixture(({root,dir,grant})=>{
  writeFileSync(join(root,'discovered.txt'),'existing');
  assert.deepEqual(listWorkspace(grant,'.').entries,[{name:'discovered.txt',type:'file'}]);
  const before=readWorkspace(grant,'discovered.txt');
  changeWorkspace(grant,dir,'task',{path:'discovered.txt',text:'changed',expectedSha256:before.sha256});
  changeWorkspace(grant,dir,'task',{path:'arbitrary/new.ts',text:'export const n = 1;',expectedSha256:null});
  assert.equal(readWorkspace(grant,'arbitrary/new.ts').text,'export const n = 1;');
  assert.deepEqual(listWorkspace(grant,'arbitrary').entries,[{name:'new.ts',type:'file'}]);
  assert.throws(()=>listWorkspace(grant,'../'),/invalid/);
}));
test('MCP applies files directly, isolates tokens, blocks terminal writes and keeps old text-only tasks compatible',()=>fixture(async({dir,root})=>{
  const service=await start({dir:join(dir,'state'),port:0,controlPort:0});
  const admin=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${service.controlPort}${path}`,{method:'POST',headers:{authorization:'Bearer '+service.key},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const call=async(name,args)=>{const r=await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await r.json()).result;};
  try {
    const registration={id:'editor',instructions:'edit',inputs:{},workspace:{root,mode:'edit'}};
    const registered=await admin('/register',registration);assert.equal(registered.status,200);
    assert.equal((await admin('/register',{...registration,id:'parallel'})).status,200);
    const token=registered.value.token;
    assert.equal((await call('write_file',{token:'wrong',path:'created.txt',text:'bad',expectedSha256:null})).isError,true);
    const changed=await call('write_file',{token,path:'created.txt',text:'from MCP',expectedSha256:null});
    assert.equal(changed.isError,false);assert.equal(readFileSync(join(root,'created.txt'),'utf8'),'from MCP');
    assert.deepEqual((await call('list_files',{token,path:'.'})).structuredContent.entries,[{name:'created.txt',type:'file'}]);
    assert.equal((await call('get_task',{token})).structuredContent.changes.length,1);
    assert.equal((await call('submit_result',{token,status:'completed',summary:'done',result:'saved'})).isError,false);
    assert.equal((await call('delete_file',{token,path:'created.txt',expectedSha256:changed.structuredContent.afterSha256})).isError,true);
    const old=await admin('/register',{id:'textonly',instructions:'review',inputs:{code:'text'}});
    assert.equal((await call('read_input',{token:old.value.token,name:'code'})).structuredContent.text,'text');
    assert.equal((await call('read_file',{token:old.value.token,path:'created.txt'})).isError,true);
    assert.equal((await admin('/register',{...registration,id:'after-terminal'})).status,200);
  } finally {await service.close();}
}));
test('MCP create/edit/delete enforces revisions, backups and operation receipts',()=>fixture(async({dir,root})=>{
  const service=await start({dir:join(dir,'state'),port:0,controlPort:0});
  const admin=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${service.controlPort}${path}`,{method:'POST',headers:{authorization:'Bearer '+service.key},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const call=async(name,args)=>{const r=await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await r.json()).result;};
  try {
    const registered=await admin('/register',{id:'crud-regression',instructions:'exercise MCP CRUD',inputs:{},workspace:{root,mode:'edit'}});assert.equal(registered.status,200);
    const token=registered.value.token;
    const missing=await call('read_file',{token,path:'cycle.txt'});assert.equal(missing.isError,false);assert.equal(missing.structuredContent.exists,false);
    const created=await call('write_file',{token,path:'cycle.txt',text:'first\n',expectedSha256:null});
    assert.equal(created.isError,false);assert.equal(created.structuredContent.action,'create');assert.equal(created.structuredContent.beforeSha256,null);assert.equal(created.structuredContent.backup,null);
    assert.equal(readFileSync(join(root,'cycle.txt'),'utf8'),'first\n');
    const first=await call('read_file',{token,path:'cycle.txt'});assert.equal(first.isError,false);assert.equal(first.structuredContent.sha256,created.structuredContent.afterSha256);
    const edited=await call('write_file',{token,path:'cycle.txt',text:'second\n',expectedSha256:first.structuredContent.sha256});
    assert.equal(edited.isError,false);assert.equal(edited.structuredContent.action,'edit');assert.equal(edited.structuredContent.beforeSha256,first.structuredContent.sha256);
    assert.equal(readFileSync(join(root,'cycle.txt'),'utf8'),'second\n');assert.equal(readFileSync(edited.structuredContent.backup,'utf8'),'first\n');
    const stale=await call('write_file',{token,path:'cycle.txt',text:'stale\n',expectedSha256:first.structuredContent.sha256});assert.equal(stale.isError,true);
    assert.equal(readFileSync(join(root,'cycle.txt'),'utf8'),'second\n');
    const second=await call('read_file',{token,path:'cycle.txt'});assert.equal(second.isError,false);assert.equal(second.structuredContent.sha256,edited.structuredContent.afterSha256);
    const deleted=await call('delete_file',{token,path:'cycle.txt',expectedSha256:second.structuredContent.sha256});
    assert.equal(deleted.isError,false);assert.equal(deleted.structuredContent.action,'delete');assert.equal(deleted.structuredContent.beforeSha256,second.structuredContent.sha256);assert.equal(deleted.structuredContent.afterSha256,null);
    assert.equal(existsSync(join(root,'cycle.txt')),false);assert.equal(readFileSync(deleted.structuredContent.backup,'utf8'),'second\n');
    const absent=await call('read_file',{token,path:'cycle.txt'});assert.equal(absent.isError,false);assert.equal(absent.structuredContent.exists,false);
    const receipts=[created.structuredContent,edited.structuredContent,deleted.structuredContent];assert.deepEqual(receipts.map(({path,action})=>({path,action})),[{path:'cycle.txt',action:'create'},{path:'cycle.txt',action:'edit'},{path:'cycle.txt',action:'delete'}]);
    assert.ok(receipts.every(receipt=>typeof receipt.operation==='string'&&receipt.operation.length>0));
    const task=await call('get_task',{token});assert.equal(task.isError,false);assert.deepEqual(task.structuredContent.changes.map(change=>change.operation),receipts.map(receipt=>receipt.operation));
  } finally {await service.close();}
}));
