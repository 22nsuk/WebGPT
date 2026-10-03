import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJsonBodyReader} from './json-body.mjs';
import {validateMessage} from './protocol.mjs';

const request=id=>({jsonrpc:'2.0',id,method:'ping'});
const boundaryIds=['x'.repeat(1024),'한'.repeat(341)+'x','😀'.repeat(256),'\u0001'.repeat(1024)];
const oversizedIds=['x'.repeat(1025),'한'.repeat(342),'😀'.repeat(256)+'x','\u0001'.repeat(1025)];

test('request ID unit keeps inclusive UTF-8 byte limits and existing integer IDs',()=>{
  for(const id of boundaryIds){
    assert.equal(Buffer.byteLength(id),1024);
    assert.equal(validateMessage(request(id)),'request');
  }
  for(const id of ['',0,-1,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER])
    assert.equal(validateMessage(request(id)),'request');
  for(const id of [null,true,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,{},[]])
    assert.throws(()=>validateMessage(request(id)),/invalid request ID or method/);
  assert.equal(validateMessage({jsonrpc:'2.0',method:'notifications/initialized'}),'notification');
  assert.throws(()=>validateMessage({...request(''),method:'notifications/initialized'}));
});

test('request ID unit rejects oversized ASCII, multibyte and escaped identifiers',()=>{
  for(const id of oversizedIds)
    assert.throws(()=>validateMessage(request(id)),/invalid request ID or method/);
});

test('request ID unit refuses huge IDs without scanning their complete UTF-8 encoding',t=>{
  const message=request('x'.repeat(8*1024*1024));
  const byteLength=t.mock.method(Buffer,'byteLength');
  assert.throws(()=>validateMessage(message),/invalid request ID or method/);
  assert.equal(byteLength.mock.callCount(),0);
});

test('request ID unit applies to decoded IDs without restricting large argument strings',async()=>{
  const read=createJsonBodyReader();
  const parse=async id=>{
    const req=Readable.from([Buffer.from(JSON.stringify(request(id)))],{objectMode:false});req.headers={};
    return read(req);
  };
  for(const id of boundaryIds)assert.equal(validateMessage(await parse(id)),'request');
  for(const id of oversizedIds){
    const message=await parse(id);
    assert.throws(()=>validateMessage(message),/invalid request ID or method/);
  }
  const text='x'.repeat(10*1024*1024);
  assert.equal(validateMessage({...request('edit'),method:'tools/call',
    params:{name:'write_file',arguments:{oldText:text,text}}}),'request');
});

test('worker rejects oversized request IDs before echo or mutation and preserves normal traffic',async t=>{
  const {start}=await import('./worker.mjs');
  const base=mkdtempSync(join(tmpdir(),'webgpt-request-ids-')),dir=join(base,'runtime'),project=join(base,'project');
  mkdirSync(project);
  const file=join(project,'unchanged.txt');writeFileSync(file,'original');
  let service;
  t.after(async()=>{try{await service?.close();}finally{rmSync(base,{recursive:true,force:true});}});
  service=await start({dir,port:0,controlPort:0,publicMcp:true,configFile:join(base,'config.json'),closeGraceMs:100});
  const control='http://127.0.0.1:'+service.controlPort;
  const url='http://127.0.0.1:'+service.mcpPort+'/mcp/'+readFileSync(join(dir,'mcp-path.key'),'utf8');
  const headers={authorization:'Bearer '+service.key};
  const registered=await fetch(control+'/register',{method:'POST',headers,body:JSON.stringify({
    id:'retained',instructions:'keep working',inputs:{},workspace:{root:project,mode:'edit'}
  })});
  assert.equal(registered.status,200);
  const {token}=await registered.json(),state=readFileSync(join(dir,'state.json'));
  const post=message=>fetch(url,{method:'POST',body:JSON.stringify(message)});
  const messages=['ping','initialize','tools/list','unknown'].map(method=>({...request(oversizedIds[0]),method}));
  messages.push({...request(oversizedIds[0]),method:'tools/call',params:{name:'write_file',arguments:{
    token,path:'unchanged.txt',text:'must not be written',expectedSha256:createHash('sha256').update('original').digest('hex')
  }}});
  messages.push(...oversizedIds.slice(1).map(request),request('x'.repeat(1024*1024)));
  for(const message of messages){
    const response=await post(message),text=await response.text();
    assert.equal(response.status,400);
    assert.ok(Buffer.byteLength(text)<256,'refusal must not reflect the oversized ID');
    assert.deepEqual(JSON.parse(text),{jsonrpc:'2.0',id:null,error:{code:-32600,message:'invalid JSON-RPC request'}});
  }
  for(const id of [...boundaryIds,'',0,Number.MAX_SAFE_INTEGER]){
    const response=await post(request(id));assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{jsonrpc:'2.0',id,result:{}});
  }
  const task=await post({...request('ordinary'),method:'tools/call',params:{name:'get_task',arguments:{token}}});
  assert.equal(task.status,200);
  assert.equal((await task.json()).result.structuredContent.instructions,'keep working');
  const ready=await fetch(control+'/ready',{headers});assert.equal(ready.status,200);assert.equal((await ready.json()).ok,true);
  assert.ok(readFileSync(join(dir,'state.json')).equals(state));
  assert.equal(readFileSync(file,'utf8'),'original');
  assert.equal(existsSync(join(dir,'recovery')),false);
});
