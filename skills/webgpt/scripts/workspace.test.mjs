import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { grantWorkspace, listWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';
import { start } from './worker.mjs';
import { callTool } from './test-fixtures/worker-http.mjs';

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
test('scope, read-only, traversal, protected files, directory links and hardlinks fail closed',()=>fixture(({dir,root,grant})=>{
  writeFileSync(join(root,'source.txt'),'safe');
  const readonly=grantWorkspace({root,mode:'read'});
  assert.equal(readWorkspace(readonly,'source.txt').text,'safe');
  for(const path of ['../outside','/etc/passwd','.git/config','new/../source.txt']) {
    assert.throws(()=>readWorkspace(grant,path));
    assert.throws(()=>changeWorkspace(grant,dir,'task',{path,text:'bad',expectedSha256:null}));
  }
  assert.throws(()=>changeWorkspace(readonly,dir,'task',{path:'source.txt',text:'bad',expectedSha256:null}),/read-only/);
  const before=readWorkspace(readonly,'source.txt');
  assert.throws(()=>changeWorkspace(readonly,dir,'task',{path:'source.txt',expectedSha256:before.sha256},true),/read-only/);
  assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'safe');
  const after=readWorkspace(readonly,'source.txt');
  assert.equal(after.sha256,before.sha256);assert.equal(after.text,before.text);
  assert.equal(existsSync(join(dir,'recovery')),false);
  assert.throws(()=>grantWorkspace({root,mode:'read',read:[],write:['source.txt']}),/root and mode only/);
  assert.throws(()=>grantWorkspace({root:'/',mode:'edit'}),/project root/);
  assert.throws(()=>grantWorkspace({root:parse(root).root,mode:'edit'}),/project root/);
  symlinkSync(dir,join(root,'new'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'new/fresh.txt',text:'escape',expectedSha256:null}),/symlink/);
  assert.equal(existsSync(join(dir,'fresh.txt')),false);
  linkSync(join(root,'source.txt'),join(dir,'hard.txt'));
  assert.throws(()=>readWorkspace(grant,'source.txt'),/hardlink/);
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'source.txt',text:'bad'}),/expectedSha256/);
}));

test('file symlinks cannot expose files outside the project',t=>fixture(({dir,root,grant})=>{
  writeFileSync(join(dir,'outside.txt'),'private');
  try { symlinkSync(join(dir,'outside.txt'),join(root,'alias.txt')); }
  catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') {
      t.skip('Windows file symlink creation requires Developer Mode or elevated privileges');
      return;
    }
    throw e;
  }
  assert.throws(()=>readWorkspace(grant,'alias.txt'),/symlink/);
}));
test('binary and oversized files cannot be read or replaced',()=>fixture(({dir,root,grant})=>{
  writeFileSync(join(root,'source.txt'),Buffer.from([0xff,0x00]));
  assert.throws(()=>readWorkspace(grant,'source.txt'),/UTF-8/);
  writeFileSync(join(root,'source.txt'),'x'.repeat(10*1024*1024+1));
  assert.throws(()=>readWorkspace(grant,'source.txt'),/10 MiB/);
  assert.throws(()=>changeWorkspace(grant,dir,'task',{path:'new/fresh.txt',text:'x'.repeat(10*1024*1024+1),expectedSha256:null}),/10 MiB/);
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
test('ill-formed workspace paths cannot alias native names or create recovery evidence',async t=>{
  const operations={
    list:(grant,dir,path)=>listWorkspace(grant,path),
    read:(grant,dir,path)=>readWorkspace(grant,path),
    create:(grant,dir,path)=>changeWorkspace(grant,dir,'invalid',{path,text:'bad',expectedSha256:null}),
    edit:(grant,dir,path,sha)=>changeWorkspace(grant,dir,'invalid',{path,text:'bad',expectedSha256:sha}),
    delete:(grant,dir,path,sha)=>changeWorkspace(grant,dir,'invalid',{path,expectedSha256:sha},true),
  };
  for(const [action,run] of Object.entries(operations))await t.test(action,()=>fixture(({dir,root,grant})=>{
    for(const [bad,native] of [['\ud800','\ufffd'],['\udc00','\ufffd'],['\udc00\ud800','\ufffd\ufffd']]) {
      const folder='dir-'+native,file=`${folder}/file-${native}.txt`;
      mkdirSync(join(root,folder),{recursive:true});
      mkdirSync(join(root,folder,'sub-'+native),{recursive:true});
      writeFileSync(join(root,file),'unchanged');
      const before=readWorkspace(grant,file),listing=listWorkspace(grant,'.');
      const paths=action==='list'?[`dir-${bad}`,`${folder}/sub-${bad}`]
        :action==='create'?[`new-${bad}/deep/fresh.txt`,`${folder}/new-${bad}.txt`]
        :[`dir-${bad}/file-${native}.txt`,`${folder}/file-${bad}.txt`];
      const children=readdirSync(join(root,folder)).sort();
      for(const path of paths) {
        assert.equal(path.isWellFormed(),false);
        assert.throws(()=>run(grant,dir,path,before.sha256),{message:'invalid path or Git metadata'});
        assert.equal(readFileSync(join(root,file),'utf8'),'unchanged');
        assert.equal(readWorkspace(grant,file).sha256,before.sha256);
        assert.deepEqual(listWorkspace(grant,'.'),listing);
        assert.deepEqual(readdirSync(join(root,folder)).sort(),children);
        assert.equal(existsSync(join(dir,'recovery')),false);
      }
    }
  }));
});
test('well-formed replacement characters, supplementary characters and Korean names remain usable',()=>fixture(({dir,root,grant})=>{
  for(const path of ['replacement-\ufffd.txt','emoji-\ud83d\ude00.txt','한국어.txt']) {
    const created=changeWorkspace(grant,dir,'unicode',{path,text:'first',expectedSha256:null});
    assert.equal(created.path,path);
    assert.equal(readWorkspace(grant,path).sha256,created.afterSha256);
    const listed=listWorkspace(grant,'.').entries;
    assert.equal(listed.length,1);assert.equal(listed[0].type,'file');
    assert.equal(readWorkspace(grant,listed[0].name).text,'first');
    const edited=changeWorkspace(grant,dir,'unicode',{path,text:'second',expectedSha256:created.afterSha256});
    assert.equal(edited.path,path);assert.equal(readFileSync(edited.backup,'utf8'),'first');
    assert.equal(readFileSync(join(root,path),'utf8'),'second');
    const deleted=changeWorkspace(grant,dir,'unicode',{path,expectedSha256:edited.afterSha256},true);
    assert.equal(deleted.path,path);assert.equal(readFileSync(deleted.backup,'utf8'),'second');
    assert.equal(readWorkspace(grant,path).exists,false);
    const recovery=inspectRecovery(dir,'unicode');
    assert.deepEqual(recovery.unresolved,[]);
    for(const receipt of [created,edited,deleted])assert.ok(recovery.receipts.some(item=>item.operation===receipt.operation&&item.path===path));
  }
}));
test('ill-formed retained receipt paths require review without rewriting journals or backups',()=>fixture(({dir,root,grant})=>{
  const path='native-\ufffd.txt';writeFileSync(join(root,path),'original');
  const before=readWorkspace(grant,path);
  const receipt=changeWorkspace(grant,dir,'legacy',{path,text:'changed',expectedSha256:before.sha256});
  assert.deepEqual(inspectRecovery(dir,'legacy'),{receipts:[receipt],unresolved:[]});
  const journal=join(dir,'recovery','legacy',receipt.operation+'.json');
  const entry=JSON.parse(readFileSync(journal,'utf8'));
  const bytes=Buffer.from(JSON.stringify({...entry,path:'native-\ud800.txt'}));
  writeFileSync(journal,bytes);
  const backup=readFileSync(receipt.backup),names=readdirSync(join(dir,'recovery','legacy')).sort();
  assert.deepEqual(inspectRecovery(dir,'legacy'),{receipts:[],unresolved:[journal]});
  assert.deepEqual(readFileSync(journal),bytes);assert.deepEqual(readFileSync(receipt.backup),backup);
  assert.equal(readFileSync(join(root,path),'utf8'),'changed');
  assert.deepEqual(readdirSync(join(dir,'recovery','legacy')).sort(),names);
}));
test('MCP applies files directly, isolates tokens, blocks terminal writes and keeps old text-only tasks compatible',()=>fixture(async({dir,root})=>{
  const service=await start({dir:join(dir,'state'),port:0,controlPort:0});
  const admin=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${service.controlPort}${path}`,{method:'POST',headers:{authorization:'Bearer '+service.key},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const call=(name,args)=>callTool(service,name,args);
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
  const runtime=join(dir,'state'),taskId='crud-regression';
  const recovery=join(runtime,'recovery',taskId);
  const service=await start({dir:runtime,port:0,controlPort:0});
  const admin=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${service.controlPort}${path}`,{method:'POST',headers:{authorization:'Bearer '+service.key},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  const call=(name,args)=>callTool(service,name,args);
  // Public MCP receipts need not expose private native backup paths. Inspect
  // evidence in this test's own runtime and match it to the public operation.
  const storedReceipt=receipt=>{
    const saved=inspectRecovery(runtime,taskId);
    assert.deepEqual(saved.unresolved,[]);
    const stored=saved.receipts.find(item=>item.operation===receipt.operation);
    assert.ok(stored,'MCP operation must have an applied recovery receipt');
    for(const field of ['path','action','beforeSha256','afterSha256'])assert.equal(stored[field],receipt[field]);
    return stored;
  };
  try {
    const registered=await admin('/register',{id:taskId,instructions:'exercise MCP CRUD',inputs:{},workspace:{root,mode:'edit'}});assert.equal(registered.status,200);
    const token=registered.value.token;
    const missing=await call('read_file',{token,path:'cycle.txt'});assert.equal(missing.isError,false);assert.equal(missing.structuredContent.exists,false);
    const created=await call('write_file',{token,path:'cycle.txt',text:'first\n',expectedSha256:null});
    assert.equal(created.isError,false);assert.equal(created.structuredContent.action,'create');assert.equal(created.structuredContent.beforeSha256,null);assert.equal(storedReceipt(created.structuredContent).backup,null);
    assert.equal(readFileSync(join(root,'cycle.txt'),'utf8'),'first\n');
    const first=await call('read_file',{token,path:'cycle.txt'});assert.equal(first.isError,false);assert.equal(first.structuredContent.sha256,created.structuredContent.afterSha256);
    const edited=await call('write_file',{token,path:'cycle.txt',text:'second\n',expectedSha256:first.structuredContent.sha256});
    assert.equal(edited.isError,false);assert.equal(edited.structuredContent.action,'edit');assert.equal(edited.structuredContent.beforeSha256,first.structuredContent.sha256);
    assert.equal(readFileSync(join(root,'cycle.txt'),'utf8'),'second\n');assert.equal(readFileSync(storedReceipt(edited.structuredContent).backup,'utf8'),'first\n');
    const stale=await call('write_file',{token,path:'cycle.txt',text:'stale\n',expectedSha256:first.structuredContent.sha256});assert.equal(stale.isError,true);
    assert.equal(readFileSync(join(root,'cycle.txt'),'utf8'),'second\n');
    const second=await call('read_file',{token,path:'cycle.txt'});assert.equal(second.isError,false);assert.equal(second.structuredContent.sha256,edited.structuredContent.afterSha256);
    const deleted=await call('delete_file',{token,path:'cycle.txt',expectedSha256:second.structuredContent.sha256});
    assert.equal(deleted.isError,false);assert.equal(deleted.structuredContent.action,'delete');assert.equal(deleted.structuredContent.beforeSha256,second.structuredContent.sha256);assert.equal(deleted.structuredContent.afterSha256,null);
    assert.equal(existsSync(join(root,'cycle.txt')),false);assert.equal(readFileSync(storedReceipt(deleted.structuredContent).backup,'utf8'),'second\n');
    const absent=await call('read_file',{token,path:'cycle.txt'});assert.equal(absent.isError,false);assert.equal(absent.structuredContent.exists,false);
    const receipts=[created.structuredContent,edited.structuredContent,deleted.structuredContent];assert.deepEqual(receipts.map(({path,action})=>({path,action})),[{path:'cycle.txt',action:'create'},{path:'cycle.txt',action:'edit'},{path:'cycle.txt',action:'delete'}]);
    assert.ok(receipts.every(receipt=>typeof receipt.operation==='string'&&receipt.operation.length>0));
    const task=await call('get_task',{token});assert.equal(task.isError,false);assert.deepEqual(task.structuredContent.changes.map(change=>change.operation),receipts.map(receipt=>receipt.operation));

    // Protocol argument validation rejects ill-formed strings before workspace
    // dispatch, without changing task state or receipts.
    const native='native-\ufffd';mkdirSync(join(root,native));
    writeFileSync(join(root,native,'file.txt'),'keep');
    const nativeRead=await call('read_file',{token,path:native+'/file.txt'});
    assert.equal(nativeRead.isError,false);
    const sha=nativeRead.structuredContent.sha256,bad='native-\ud800';
    const statePath=join(runtime,'state.json'),state=readFileSync(statePath);
    const evidence=readdirSync(recovery).sort();
    for(const [name,args] of [
      ['list_files',{path:bad}],['read_file',{path:bad+'/file.txt'}],
      ['write_file',{path:bad+'/file.txt',text:'bad',expectedSha256:sha}],
      ['delete_file',{path:bad+'/file.txt',expectedSha256:sha}],
      ['write_file',{path:'new-\udc00/deep/file.txt',text:'bad',expectedSha256:null}],
    ]) {
      const rejected=await call(name,{token,...args});
      assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/invalid tool argument value/);
      assert.deepEqual(readFileSync(statePath),state);
      assert.deepEqual(readdirSync(recovery).sort(),evidence);
      assert.equal(readFileSync(join(root,native,'file.txt'),'utf8'),'keep');
      assert.deepEqual(readdirSync(root),[native]);
    }
    const retained=await call('get_task',{token});assert.equal(retained.isError,false);
    assert.deepEqual(retained.structuredContent.changes,task.structuredContent.changes);
  } finally {await service.close();}
}));
