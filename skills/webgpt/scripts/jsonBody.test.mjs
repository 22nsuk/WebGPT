import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable,PassThrough} from 'node:stream';
import {setImmediate as tick} from 'node:timers/promises';
import {createJsonBodyReader} from './json-body.mjs';
import {createServer,request} from 'node:http';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const MiB=1024*1024, page=64*1024;
function input(chunks,headers={}){
  const req=Readable.from(chunks,{objectMode:true});req.headers=headers;return req;
}
function pending(){const req=new PassThrough();req.headers={};return req;}
const refused=statusCode=>error=>error.statusCode===statusCode;
const parsed=(text,limit)=>createJsonBodyReader(limit)(input([Buffer.from(text)]));

// These limits concern structure, not the size of legitimate escaped text fields.
test('JSON body preserves Unicode, escapes, primitives and every two-chunk split',async()=>{
  const value={text:'한글 😀 \\" [{,:}] \\u005b \u0001',a:[null,true,false,-1.25e4,{},[]]};
  const bytes=Buffer.from(JSON.stringify(value));
  for(let at=0;at<=bytes.length;at++)
    assert.deepEqual(await createJsonBodyReader()(input([bytes.subarray(0,at),bytes.subarray(at)])),value);
  for(const value of [null,true,false,0,-1.5,'',{},[]])
    assert.deepEqual(await parsed(JSON.stringify(value)),value);
  assert.deepEqual(await parsed('\ufeff{"x":1}'),{x:1});
});
test('JSON body accepts depth 64 and rejects depth 65 before JSON.parse',async t=>{
  await parsed('['.repeat(64)+'0'+']'.repeat(64));
  const parse=t.mock.method(JSON,'parse');
  await assert.rejects(parsed('['.repeat(65)+'0'+']'.repeat(65)),refused(413));
  assert.equal(parse.mock.callCount(),0);
});
test('JSON body bounds shallow containers, scalar arrays and duplicate object keys before parsing',async t=>{
  const parse=t.mock.method(JSON,'parse');
  for(const text of ['['+'[],'.repeat(22000)+'[]]', '['+'0,'.repeat(65536)+'0]', '{'+'"x":0,'.repeat(22000)+'"x":0}'])
    await assert.rejects(parsed(text,128*MiB),refused(413));
  assert.equal(parse.mock.callCount(),0);
});
test('JSON body structural budget is inclusive and survives chunk boundaries',async()=>{
  // For n numbers: two brackets and n-1 commas, so n=65535 reaches 65536.
  const text='['+'0,'.repeat(65534)+'0]';
  assert.equal((await parsed(text)).length,65535);
  await assert.rejects(createJsonBodyReader()(input([Buffer.from(text.slice(0,-1)),Buffer.from(',0]')])),refused(413));
});
test('JSON body rejects an overdeep prefix without consuming the remaining stream',async t=>{
  let tailRead=false;
  // A non-prefetching iterator makes the early-consumption assertion deterministic.
  const req={headers:{},iterator:()=> (async function*(){
    yield Buffer.from('['.repeat(65));tailRead=true;yield Buffer.from('0'+']'.repeat(65));
  })()};
  const parse=t.mock.method(JSON,'parse');
  await assert.rejects(createJsonBodyReader()(req),refused(413));
  assert.equal(tailRead,false);assert.equal(parse.mock.callCount(),0);
});
test('JSON body keeps declared and received byte limits and releases capacity on failures',async()=>{
  const read=createJsonBodyReader(8);
  assert.deepEqual(await read(input([Buffer.from('{"x":1} ')])),{x:1});
  await assert.rejects(read(input([] ,{'content-length':'9'})),refused(413));
  await assert.rejects(read(input([Buffer.from('{"x":1}  ')])),refused(413));
  await assert.rejects(read(input([Buffer.from('{bad}')])),SyntaxError);
  assert.deepEqual(await read(input([Buffer.from('{}')])),{});
});
test('JSON body retains strict UTF-8 and JSON validation',async()=>{
  const read=createJsonBodyReader();
  for(const bytes of [Buffer.from([0x22,0xff,0x22]),Buffer.from([0x22,0xe2,0x82])])
    await assert.rejects(read(input([bytes])),TypeError);
  for(const text of ['', '{', ']', '{"x":1,}', '"bad\\q"','{"x":true} trailing'])
    await assert.rejects(read(input([Buffer.from(text)])),SyntaxError);
  assert.deepEqual(await read(input([Buffer.from('{}')])),{});
});
test('JSON body bounds concurrent readers independently and recovers after disconnect',async()=>{
  const read=createJsonBodyReader(),other=createJsonBodyReader();
  const streams=Array.from({length:4},pending),jobs=streams.map(req=>read(req));
  // Attach a rejection handler before inducing an abort.
  const aborted=assert.rejects(jobs[0],/fixture disconnect/);
  try{
    await assert.rejects(read(input([Buffer.from('{}')])),refused(503));
    assert.deepEqual(await other(input([Buffer.from('{}')])),{});
    streams[0].destroy(Error('fixture disconnect'));await aborted;
    assert.deepEqual(await read(input([Buffer.from('{}')])),{});
    for(const req of streams.slice(1))req.end('{}');
    assert.deepEqual(await Promise.all(jobs.slice(1)),[{},{},{}]);
  }finally{for(const req of streams)req.destroy();await Promise.allSettled(jobs);}
});
test('JSON body bounds aggregate retained pages and releases them after completion',async()=>{
  const read=createJsonBodyReader(2*page),a=pending(),b=pending();
  const jobs=[read(a),read(b)];
  try{
    a.write('{}'+' '.repeat(page-2));b.write('{}'+' '.repeat(page-2));
    await tick();
    await assert.rejects(read(input([Buffer.from('{}')])),refused(503));
    a.end();assert.deepEqual(await jobs[0],{});
    assert.deepEqual(await read(input([Buffer.from('{}')])),{});
    b.end();assert.deepEqual(await jobs[1],{});
  }finally{a.destroy();b.destroy();await Promise.allSettled(jobs);}
});
test('JSON body coalesces tiny wire fragments instead of retaining one buffer per fragment',async t=>{
  const alloc=t.mock.method(Buffer,'allocUnsafe');
  const count=page+3;
  const req=input((function*(){yield Buffer.from('"');for(let i=0;i<count;i++)yield Buffer.from('x');yield Buffer.from('"');})());
  assert.equal((await createJsonBodyReader(2*page)(req)).length,count);
  assert.equal(alloc.mock.calls.filter(c=>c.arguments[0]===page).length,2);
});
test('JSON body accepts two fully escaped 10 MiB edit strings within the 128 MiB allowance',async()=>{
  const part=Buffer.from('\\u0001'.repeat(64*1024));
  let received=0;
  const req=input((function*(){
    yield Buffer.from('{"oldText":"');
    for(let i=0;i<160;i++){received+=part.length;yield part;}
    yield Buffer.from('","text":"');
    for(let i=0;i<160;i++){received+=part.length;yield part;}
    yield Buffer.from('"}');
  })());
  const value=await createJsonBodyReader(128*MiB)(req);
  assert.equal(received,120*MiB);
  for(const key of ['oldText','text']){
    assert.equal(value[key].length,10*MiB);assert.equal(value[key][0],'\u0001');assert.equal(value[key].at(-1),'\u0001');
  }
});

// Deliberately never finish the body: refusal must flush without waiting for EOF.
function prefixRequest(port,path,prefix,headers={}){
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,method:'POST',agent:false,headers},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);
      res.on('end',()=>{
        clearTimeout(timer);req.destroy();
        resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')});
      });
    });
    const timer=setTimeout(()=>req.destroy(Error('early rejection did not complete')),10000);
    req.on('error',error=>{clearTimeout(timer);reject(error);});req.write(prefix);
  });
}
test('JSON body HTTP receiver returns 413 before declared or chunked bodies finish',async t=>{
  const read=createJsonBodyReader(128*MiB);
  const server=createServer(async(req,res)=>{
    try{await read(req);res.end('{}');}
    catch(error){if(!req.complete)res.setHeader('connection','close');res.writeHead(error.statusCode??400);res.end('{}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  for(const headers of [{},{'content-length':String(96*MiB)}]){
    const result=await prefixRequest(server.address().port,'/', '['.repeat(65),headers);
    assert.equal(result.status,413);assert.equal(result.headers.connection,'close');
  }
  const response=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',body:'{}'});
  assert.equal(response.status,200);await response.text();
});

async function workerFixture(t){
  const {start}=await import('./worker.mjs');
  const base=mkdtempSync(join(tmpdir(),'webgpt-json-body-')),dir=join(base,'runtime'),project=join(base,'project');
  mkdirSync(project);
  let service;
  t.after(async()=>{try{await service?.close();}finally{rmSync(base,{recursive:true,force:true});}});
  service=await start({dir,port:0,controlPort:0,publicMcp:true,configFile:join(base,'config.json'),closeGraceMs:100});
  const route='/mcp/'+readFileSync(join(dir,'mcp-path.key'),'utf8');
  const url='http://127.0.0.1:'+service.mcpPort+route;
  const admin=async(path,value)=>{
    const response=await fetch('http://127.0.0.1:'+service.controlPort+path,{
      method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+service.key},
      body:value===undefined?undefined:JSON.stringify(value)
    });
    assert.equal(response.status,200);return response.json();
  };
  return {service,dir,project,route,url,admin};
}
test('worker body rejects tokenless complex requests and retains MCP, controller and task availability',async t=>{
  const {service,dir,route,url,admin}=await workerFixture(t);
  const task=await admin('/register',{id:'retained',instructions:'keep working',inputs:{}});
  const state=readFileSync(join(dir,'state.json'));
  const prefix='{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":';
  // This is the reported request shape, but only its bounded offending prefix
  // is transmitted. No destructive heap-exhaustion payload is sent by the suite.
  for(const headers of [{},{'content-length':String(96*MiB)}]){
    const response=await prefixRequest(service.mcpPort,route,prefix+'['.repeat(65),headers);
    assert.equal(response.status,413);
    assert.deepEqual(JSON.parse(response.text),{jsonrpc:'2.0',id:null,error:{code:-32600,message:'request too large'}});
  }
  for(const value of ['['+'[],'.repeat(22000)+'[]]','['+'0,'.repeat(65536)+'0]', '{'+'"x":0,'.repeat(22000)+'"x":0}']){
    const response=await fetch(url,{method:'POST',body:prefix+value+'}}'});
    assert.equal(response.status,413);assert.equal((await response.json()).error.code,-32600);
  }
  const ping=await fetch(url,{method:'POST',body:'{"jsonrpc":"2.0","id":2,"method":"ping"}'});
  assert.equal(ping.status,200);assert.deepEqual((await ping.json()).result,{});
  const ready=await admin('/ready');assert.equal(ready.ok,true);
  const result=await fetch(url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_task',arguments:{token:task.token}}})});
  assert.equal((await result.json()).result.structuredContent.instructions,'keep working');
  assert.ok(readFileSync(join(dir,'state.json')).equals(state));
});
test('worker body keeps controller admission available while MCP body slots are occupied',async t=>{
  const {service,route,url,admin}=await workerFixture(t);
  const clients=[];
  t.after(()=>{for(const client of clients)client.destroy();});
  for(let i=0;i<4;i++)await new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:service.mcpPort,path:route,method:'POST',agent:false},res=>res.resume());
    clients.push(req);req.on('error',reject);req.write('{',resolve);
  });
  // Allow already-sent prefixes to reach the server, using an observable result
  // rather than treating a fixed sleep or client write callback as admission.
  let overloaded=false;
  const deadline=performance.now()+10000;
  while(performance.now()<deadline){
    const response=await fetch(url,{method:'POST',body:'{"jsonrpc":"2.0","id":1,"method":"ping"}'});
    const body=await response.json();
    if(response.status===503){assert.equal(body.error.code,-32000);overloaded=true;break;}
    assert.equal(response.status,200);await tick();
  }
  assert.equal(overloaded,true);
  assert.equal((await admin('/ready')).ok,true);
  assert.equal((await admin('/register',{id:'controller-still-works',instructions:'ok',inputs:{}})).id,'controller-still-works');
});
test('worker body preserves a fully escaped maximum-size exact file edit',async t=>{
  const {project,url,admin}=await workerFixture(t),file=join(project,'large.txt');
  const original=Buffer.alloc(10*MiB,1);writeFileSync(file,original);
  const expectedSha256=createHash('sha256').update(original).digest('hex');
  const {token}=await admin('/register',{id:'large-edit',instructions:'edit',inputs:{},workspace:{root:project,mode:'edit'}});
  const args=JSON.stringify({token,path:'large.txt',expectedSha256}).slice(0,-1);
  const head='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":'+args+',"oldText":"';
  const middle='","text":"',tail='"}}}';
  const chunks=(function*(){
    yield Buffer.from(head);
    for(const [index,escape] of ['\\u0001','\\u0002'].entries()){
      if(index)yield Buffer.from(middle);
      const part=Buffer.from(escape.repeat(64*1024));
      for(let i=0;i<160;i++)yield part;
    }
    yield Buffer.from(tail);
  })();
  const response=await fetch(url,{method:'POST',duplex:'half',
    headers:{'content-length':String(Buffer.byteLength(head+middle+tail)+120*MiB)},body:Readable.from(chunks)});
  assert.equal(response.status,200);
  const result=(await response.json()).result;assert.equal(result.isError,false,JSON.stringify(result));
  assert.ok(readFileSync(file).equals(Buffer.alloc(10*MiB,2)));
  assert.equal((await admin('/ready')).ok,true);
});
