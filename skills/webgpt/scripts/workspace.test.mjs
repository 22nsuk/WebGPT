import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantWorkspace, grantsOverlap, readWorkspace, changeWorkspace } from './workspace.mjs';
import { start } from './worker.mjs';

const fixture = fn => {
  const dir=mkdtempSync(join(tmpdir(),'webgpt-files-'));
  const root=join(dir,'project');mkdirSync(root);
  const grant=grantWorkspace({root,mode:'edit',read:[],write:['source.txt','new/fresh.txt','alias.txt']});
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
  const readonly=grantWorkspace({root,mode:'read',read:['source.txt'],write:[]});
  assert.equal(readWorkspace(readonly,'source.txt').text,'safe');
  for(const path of ['../outside','/etc/passwd','unowned.txt','.git/config','.env','new/../source.txt']) {
    assert.throws(()=>readWorkspace(grant,path));
    assert.throws(()=>changeWorkspace(grant,dir,'task',{path,text:'bad',expectedSha256:null}));
  }
  assert.throws(()=>changeWorkspace(readonly,dir,'task',{path:'source.txt',text:'bad',expectedSha256:null}),/write scope/);
  assert.throws(()=>grantWorkspace({root,mode:'read',read:[],write:['source.txt']}),/read-only/);
  assert.throws(()=>grantWorkspace({root:'/',mode:'edit',read:[],write:[]}),/project root/);
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
test('overlapping reader/writer grants are rejected while independent tasks may run',()=>fixture(({root,grant})=>{
  const read=grantWorkspace({root,mode:'read',read:['source.txt'],write:[]});
  assert.equal(grantsOverlap(grant,read),true);assert.equal(grantsOverlap(read,grant),true);
  assert.equal(grantsOverlap(read,read),false);
  assert.equal(grantsOverlap(grant,grantWorkspace({root,mode:'edit',read:[],write:['separate.txt']})),false);
}));
test('MCP applies files directly, isolates tokens, blocks terminal writes and keeps old text-only tasks compatible',()=>fixture(async({dir,root})=>{
  const service=await start({dir:join(dir,'state'),port:0,controlPort:0});
  const admin=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${service.controlPort}${path}`,{method:'POST',headers:{authorization:'Bearer '+service.key},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const call=async(name,args)=>{const r=await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await r.json()).result;};
  try {
    const registration={id:'editor',instructions:'edit',inputs:{},workspace:{root,mode:'edit',read:[],write:['created.txt']}};
    const registered=await admin('/register',registration);assert.equal(registered.status,200);
    assert.equal((await admin('/register',{...registration,id:'overlap'})).status,400);
    const token=registered.value.token;
    assert.equal((await call('write_file',{token:'wrong',path:'created.txt',text:'bad',expectedSha256:null})).isError,true);
    const changed=await call('write_file',{token,path:'created.txt',text:'from MCP',expectedSha256:null});
    assert.equal(changed.isError,false);assert.equal(readFileSync(join(root,'created.txt'),'utf8'),'from MCP');
    assert.equal((await call('get_task',{token})).structuredContent.changes.length,1);
    assert.equal((await call('submit_result',{token,status:'completed',summary:'done',result:'saved'})).isError,false);
    assert.equal((await call('delete_file',{token,path:'created.txt',expectedSha256:changed.structuredContent.afterSha256})).isError,true);
    const old=await admin('/register',{id:'textonly',instructions:'review',inputs:{code:'text'}});
    assert.equal((await call('read_input',{token:old.value.token,name:'code'})).structuredContent.text,'text');
    assert.equal((await call('read_file',{token:old.value.token,path:'created.txt'})).isError,true);
    assert.equal((await admin('/register',{...registration,id:'after-terminal'})).status,200);
  } finally {await service.close();}
}));
