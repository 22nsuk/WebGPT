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

// Input windows exercise the real MCP path without granting a project. Existing
// file-window tests above remain the compatibility tests for the shared selector.
async function inputFixture(inputs, run) {
  return fixture(async f => {
    const dir=join(f.base,'runtime');
    let worker=await start({dir,port:0,controlPort:0});
    const config={dataDir:dir,controlPort:worker.controlPort};
    const task=await request('register',{id:'inputs',instructions:'Read supplied material',inputs},config);
    const rpc=async(method,params)=>{
      const response=await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`,{method:'POST',
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      const bytes=Buffer.from(await response.arrayBuffer());
      return {bytes,result:JSON.parse(bytes).result};
    };
    const tool=async(name,args={})=>(await rpc('tools/call',{name,arguments:{token:task.token,...args}})).result;
    const read=async(name,options={})=>{
      const result=await tool('read_input',{name,...options});
      assert.equal(result.isError,false,JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
      return result.structuredContent;
    };
    try {await run({...f,dir,config,task,rpc,tool,read,state:()=>readFileSync(join(dir,'state.json')),
      restart:async()=>{await worker.close();worker=await start({dir,port:0,controlPort:0});config.controlPort=worker.controlPort;}});}
    finally {await worker.close();}
  });
}

test('read_input advertises optional windows but keeps its full response and seven-tool boundary',()=>
  inputFixture({doc:'\ufeff한글 😀\r\nzero\0end\n'},async({rpc,read,tool,state})=>{
    const before=state(),listed=(await rpc('tools/list',{})).result.tools;
    assert.equal(listed.length,7);
    const input=listed.find(t=>t.name==='read_input'),file=listed.find(t=>t.name==='read_file');
    assert.deepEqual(input.inputSchema.required,['token','name']);
    assert.equal(input.inputSchema.additionalProperties,false);assert.equal(input.annotations.readOnlyHint,true);
    for(const key of ['offset','limit','maxChars'])assert.deepEqual(input.inputSchema.properties[key],file.inputSchema.properties[key]);
    assert.deepEqual(await read('doc'),{name:'doc',text:'\ufeff한글 😀\r\nzero\0end\n'});
    assert.equal((await tool('read_file',{path:'doc',limit:1})).isError,true,'an input gives no file grant');
    assert.deepEqual(state(),before);
  }));

test('input pages reconstruct exact Unicode, BOM, NUL and mixed endings with one whole-input digest',()=>
  inputFixture({doc:'\ufeff첫째 😀\r\n\r\nthird\rfourth\0\n마지막 🧪',empty:'',terminated:'a\n',blank:'\r\n'},
  async({read,tool,state})=>{
    const before=state(),full=await read('doc');let offset=1,assembled='';const ranges=[];
    do {
      const page=await read('doc',{offset,limit:2});assembled+=page.text;ranges.push([page.startLine,page.endLine]);
      assert.equal(page.totalLines,5);assert.equal(page.partial,true);assert.equal(page.text.isWellFormed(),true);
      assert.equal(page.sha256,sha(full.text));offset=page.nextOffset;
    }while(offset!==null);
    assert.equal(assembled,full.text);assert.deepEqual(ranges,[[1,2],[3,4],[5,5]]);
    assert.equal((await read('doc',{limit:5})).partial,false);
    for(const [name,lines] of [['empty',0],['terminated',1],['blank',1]]){
      const page=await read(name,{offset:1});assert.equal(page.totalLines,lines);assert.equal(page.endLine,lines);
      assert.equal(page.nextOffset,null);assert.equal(page.partial,false);assert.equal(page.sha256,sha((await read(name)).text));
      assert.equal((await tool('read_input',{name,offset:2})).isError,true);
    }
    assert.deepEqual(state(),before);
  }));

test('input windows enforce line and character limits without dropping tails or widening bad requests',()=>
  inputFixture({doc:'a\n😀😀\nlast',long:'x'.repeat(200001),many:'a\n'.repeat(501)},async({read,tool,state})=>{
    const before=state(),first=await read('doc',{maxChars:4});
    assert.equal(first.text,'a\n');assert.equal(first.nextOffset,2);
    const rejected=await tool('read_input',{name:'doc',offset:2,maxChars:4});
    assert.equal(rejected.isError,true);assert.match(rejected.content[0].text,/exceeds maxChars/);
    const rest=await read('doc',{offset:2,maxChars:9});
    assert.equal(first.text+rest.text,(await read('doc')).text);assert.equal(rest.nextOffset,null);
    assert.equal((await read('many',{offset:1})).endLine,400,'bounded default limit');
    assert.equal((await read('many',{limit:5000,maxChars:200000})).partial,false);
    assert.equal((await tool('read_input',{name:'long',maxChars:200000})).isError,true);
    assert.equal((await read('long')).text.length,200001,'unchanged explicit full-read escape for one long line');
    for(const options of [{offset:0},{offset:1.5},{offset:Number.MAX_SAFE_INTEGER+1},{offset:1000},
      {limit:0},{limit:5001},{limit:'1'},{limit:null},{maxChars:0},{maxChars:200001},{maxChars:false},{unexpected:1}])
      assert.equal((await tool('read_input',{name:'doc',...options})).isError,true,JSON.stringify(options));
    assert.deepEqual(state(),before);
  }));

test('input names stay exact task-owned keys, never filesystem paths or inherited properties',()=>
  inputFixture(Object.fromEntries([['../outside.txt','supplied, not a path\n'],['__proto__','own input\n'],['same','first task\n']]),
  async({config,task,read,tool,state})=>{
    const other=await request('register',{id:'other',instructions:'Separate',inputs:{same:'second task\n',private:'not shared'}},config);
    const before=state();
    assert.equal((await read('../outside.txt',{limit:1})).text,'supplied, not a path\n');
    assert.equal((await read('__proto__',{limit:1})).text,'own input\n');
    for(const name of ['constructor','toString','private','/etc/passwd'])
      assert.equal((await tool('read_input',{name,limit:1})).isError,true);
    assert.equal((await read('same',{limit:1})).text,'first task\n');
    assert.equal((await read('same',{token:other.token,limit:1})).text,'second task\n');
    assert.equal((await tool('read_input',{name:'same',token:task.token+'wrong',limit:1})).isError,true);
    assert.deepEqual(state(),before);
  }));

test('input revision survives restart and terminal review, then existing collection retires access',()=>
  inputFixture({doc:'first\nretained 한국어\n'},async({read,tool,restart,config,task,state})=>{
    const page=await read('doc',{limit:1});await restart();
    const afterRestart=state();assert.deepEqual(await read('doc',{limit:1}),page);assert.deepEqual(state(),afterRestart);
    assert.equal((await tool('submit_result',{status:'completed',summary:'done',result:'reviewed'})).isError,false);
    const completed=state();assert.deepEqual(await read('doc',{limit:1}),page);assert.deepEqual(state(),completed);
    // Use the existing guarded collection; window reads themselves never retire work.
    await request('collect',{id:task.id,expectedStatus:'completed',expectedSha256:sha('reviewed')},config);
    const collected=state();assert.equal((await tool('read_input',{name:'doc',limit:1})).isError,true);
    assert.deepEqual(state(),collected);assert.equal(JSON.parse(collected)[0].token,undefined);
  }));

test('ranged input cannot bypass fresh state validation',()=>inputFixture({doc:'first\nsecond'},async({dir,read,tool,state})=>{
  await read('doc',{limit:1});writeFileSync(join(dir,'state.json'),'invalid fixture state');
  const invalid=state();assert.equal((await tool('read_input',{name:'doc',limit:1})).isError,true);
  assert.deepEqual(state(),invalid,'do not repair or reset state to read an input');
}));

test('long-input window bounds both MCP representations while preserving exact selected lines and full digest',()=>{
  const lines=Array.from({length:2048},(_,i)=>String(i+1).padStart(4,'0')+' '+'x'.repeat(58)+'\n');
  return inputFixture({doc:lines.join('')},async({rpc,task,state})=>{
    const before=state(),invoke=options=>rpc('tools/call',{name:'read_input',arguments:{token:task.token,name:'doc',...options}});
    const full=await invoke({}),part=await invoke({offset:1001,limit:8,maxChars:512});
    assert.equal(full.result.isError,false);assert.equal(part.result.isError,false);
    const page=part.result.structuredContent;
    assert.equal(page.text,lines.slice(1000,1008).join(''));assert.equal(Buffer.byteLength(page.text),512);
    assert.equal(page.sha256,sha(lines.join('')));assert.notEqual(page.sha256,sha(page.text));
    assert.deepEqual([page.startLine,page.endLine,page.totalLines,page.nextOffset],[1001,1008,2048,1009]);
    assert.equal(page.partial,true);assert.deepEqual(JSON.parse(part.result.content[0].text),page);
    const defaultWindow=(await invoke({offset:1})).result.structuredContent;
    assert.equal(defaultWindow.text.length,16000);assert.equal(defaultWindow.nextOffset,251);
    assert.ok(part.bytes.length<full.bytes.length/50,'both structured/text envelopes must omit the unrequested tail');
    assert.deepEqual(state(),before);
  });
});
