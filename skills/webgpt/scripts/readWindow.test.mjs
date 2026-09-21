import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grantWorkspace, readWorkspace, changeWorkspace } from './workspace.mjs';
import { request } from './client.mjs';
import { start } from './worker.mjs';

async function fixture(run) {
  const base=mkdtempSync(join(tmpdir(),'webgpt-read-window-')),root=join(base,'project');
  mkdirSync(root);
  try {await run({base,root,grant:grantWorkspace({root,mode:'edit'})});}
  finally {rmSync(base,{recursive:true,force:true});}
}
const sha = text => createHash('sha256').update(text).digest('hex');

test('bounded reads preserve the whole-file default and original Unicode/line endings across pages',()=>fixture(({root,grant})=>{
  const text='첫째 😀\r\n\r\nthird\rfourth\n마지막 🧪';
  writeFileSync(join(root,'source.txt'),text);
  const full=readWorkspace(grant,'source.txt');
  assert.equal(full.text,text);
  assert.equal(full.sha256,sha(text));
  assert.equal(Object.hasOwn(full,'partial'),false);
  assert.deepEqual(readWorkspace(grant,'source.txt',{}),full);
  assert.deepEqual(readWorkspace(grant,'source.txt',{offset:undefined,limit:undefined,maxChars:undefined}),full);
  let offset=1,assembled='';
  const ranges=[];
  do {
    const page=readWorkspace(grant,'source.txt',{offset,limit:2});
    assembled+=page.text;ranges.push([page.startLine,page.endLine]);
    assert.equal(page.totalLines,5);assert.equal(page.partial,true);
    assert.equal(page.sha256,full.sha256);assert.equal(page.text.isWellFormed(),true);
    offset=page.nextOffset;
  } while(offset!==null);
  assert.equal(assembled,text);
  assert.deepEqual(ranges,[[1,2],[3,4],[5,5]]);
  assert.equal(readWorkspace(grant,'source.txt',{limit:10}).partial,false);
}));

test('character bounds return complete lines and a continuation without losing a long-line tail',()=>fixture(({root,grant})=>{
  const text='a\n😀😀\nlast';writeFileSync(join(root,'source.txt'),text);
  const first=readWorkspace(grant,'source.txt',{maxChars:4});
  assert.equal(first.text,'a\n');assert.equal(first.nextOffset,2);
  assert.throws(()=>readWorkspace(grant,'source.txt',{offset:first.nextOffset,maxChars:4}),/first requested line exceeds maxChars/);
  const rest=readWorkspace(grant,'source.txt',{offset:2,maxChars:20});
  assert.equal(first.text+rest.text,text);assert.equal(rest.nextOffset,null);
  writeFileSync(join(root,'long.txt'),'x'.repeat(200001));
  assert.throws(()=>readWorkspace(grant,'long.txt',{maxChars:200000}),/exceeds maxChars/);
  assert.equal(readWorkspace(grant,'long.txt').text.length,200001);
}));

test('empty and missing files retain distinct results and range bounds are checked',()=>fixture(({root,grant})=>{
  writeFileSync(join(root,'empty.txt'),'');
  const empty=readWorkspace(grant,'empty.txt',{offset:1});
  assert.equal(empty.exists,true);assert.equal(empty.text,'');assert.equal(empty.partial,false);
  assert.equal(empty.startLine,1);assert.equal(empty.endLine,0);assert.equal(empty.totalLines,0);assert.equal(empty.nextOffset,null);
  assert.deepEqual(readWorkspace(grant,'missing.txt',{limit:1}),{path:'missing.txt',exists:false,text:null,sha256:null});
  for(const options of [{offset:0},{offset:1.5},{offset:Number.MAX_SAFE_INTEGER+1},{limit:0},{limit:5001},{maxChars:0},{maxChars:200001},{limit:'1'},{limit:null},{unknown:1},null,[]]) {
    assert.throws(()=>readWorkspace(grant,'empty.txt',options),/invalid read/);
  }
  assert.throws(()=>readWorkspace(grant,'empty.txt',{offset:2}),/beyond the file/);
}));

test('range revisions detect edits outside the window and preserve stale-write protection',()=>fixture(({base,root,grant})=>{
  writeFileSync(join(root,'source.txt'),'first\nsecond\n');
  const page=readWorkspace(grant,'source.txt',{limit:1});
  writeFileSync(join(root,'source.txt'),'first\nchanged elsewhere\n');
  const newer=readWorkspace(grant,'source.txt',{limit:1});
  assert.equal(page.text,newer.text);assert.notEqual(page.sha256,newer.sha256);
  assert.throws(()=>changeWorkspace(grant,join(base,'runtime'),'edit',{path:'source.txt',text:'replacement',expectedSha256:page.sha256}),/revision conflict/);
  assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'first\nchanged elsewhere\n');
}));

test('range reading keeps file scope, read grants, link checks and whole-file limits',()=>fixture(({base,root,grant})=>{
  writeFileSync(join(root,'safe.txt'),'safe');
  const readOnly=grantWorkspace({root,mode:'read'});
  assert.equal(readWorkspace(readOnly,'safe.txt',{limit:1}).text,'safe');
  for(const path of ['../outside.txt','.git/config','GIT~1/config']) assert.throws(()=>readWorkspace(grant,path,{limit:1}),/invalid path|Git metadata/);
  linkSync(join(root,'safe.txt'),join(base,'hardlink.txt'));
  assert.throws(()=>readWorkspace(grant,'safe.txt',{limit:1}),/hardlink/);
  symlinkSync(base,join(root,'outside'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>readWorkspace(grant,'outside/hardlink.txt',{limit:1}),/symlink/);
  writeFileSync(join(root,'invalid.txt'),Buffer.from([0x61,0x0a,0xff]));
  assert.throws(()=>readWorkspace(grant,'invalid.txt',{limit:1}),/UTF-8/);
  writeFileSync(join(root,'large.txt'),'a\n'+'x'.repeat(1024*1024));
  assert.throws(()=>readWorkspace(grant,'large.txt',{limit:1}),/1 MiB/);
}));

test('MCP advertises optional bounded read arguments and returns range metadata with whole-file hash',()=>fixture(async({base,root})=>{
  const text='하나 😀\r\n둘\n셋';writeFileSync(join(root,'source.txt'),text);
  const service=await start({dir:join(base,'runtime'),port:0,controlPort:0});
  const config={dataDir:join(base,'runtime'),controlPort:service.controlPort};
  const rpc=async(method,params)=>{
    const response=await fetch(`http://127.0.0.1:${service.mcpPort}/mcp`,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    return response.json();
  };
  try {
    const registered=await request('register',{id:'reader',instructions:'Review',inputs:{},workspace:{root,mode:'read'}},config);
    const listed=(await rpc('tools/list',{})).result.tools;
    assert.equal(listed.length,7);
    const schema=listed.find(tool=>tool.name==='read_file').inputSchema;
    assert.deepEqual(schema.required,['token','path']);assert.equal(schema.properties.limit.maximum,5000);
    const invoke=args=>rpc('tools/call',{name:'read_file',arguments:{token:registered.token,path:'source.txt',...args}});
    const page=(await invoke({offset:2,limit:1,maxChars:20})).result;
    assert.equal(page.isError,false);assert.equal(page.structuredContent.text,'둘\n');
    assert.equal(page.structuredContent.partial,true);assert.equal(page.structuredContent.sha256,sha(text));
    assert.equal(page.structuredContent.nextOffset,3);
    const full=(await invoke({})).result.structuredContent;
    assert.equal(full.text,text);assert.equal(Object.hasOwn(full,'partial'),false);
    for(const args of [{limit:5001},{offset:0},{maxChars:200001},{limit:'2'},{unknown:1}]) {
      assert.equal((await invoke(args)).result.isError,true,'invalid range arguments must fail before file access');
    }
    assert.equal((await invoke({token:'wrong',limit:1})).result.isError,true);
  } finally {await service.close();}
}));
