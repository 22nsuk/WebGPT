import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {start} from './worker.mjs';
test('private tasks, completion notification, persistence, retry and backup removal',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'webgpt-worker-test-'));let s=await start({dir,port:0,controlPort:0,backupMs:10});
 try{
  const admin=async(path,a)=>{const r=await fetch('http://127.0.0.1:'+s.controlPort+path,{method:a?'POST':'GET',headers:{authorization:'Bearer '+s.key},body:a?JSON.stringify(a):undefined});assert.equal(r.status,200);return r.json();};
  const invoke=async(name,args)=>{const r=await fetch('http://127.0.0.1:'+s.mcpPort+'/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return (await r.json()).result;};
  const a=await admin('/register',{id:'a',instructions:'Review',inputs:{code:'hello'}});
  assert.equal((await invoke('get_task',{token:'wrong'})).isError,true);
  assert.equal((await invoke('read_input',{token:a.token,name:'../../etc/passwd'})).isError,true);
  assert.equal((await invoke('read_input',{token:a.token,name:'code'})).structuredContent.text,'hello');
  const b=await admin('/register',{id:'b',instructions:'Review',inputs:{}});
  const waiting=admin('/wait');
  const payload={token:a.token,status:'completed',summary:'done',result:'result 한국어'};
  assert.equal((await invoke('submit_result',payload)).isError,false);await waiting;
  const v=await admin('/status');assert.equal(v.events[0].id,'a');assert.ok(!v.backupDue.includes('a'));
  assert.equal(readFileSync(v.events[0].artifact,'utf8'),'result 한국어');
  assert.equal((await invoke('submit_result',payload)).structuredContent.duplicate,true);
  assert.equal((await invoke('submit_result',{...payload,result:'changed'})).isError,true);
  await admin('/ack',{id:'a'});await admin('/cancel',{id:'b'});
  assert.deepEqual(await admin('/status'),{events:[],backupDue:[]});
  await s.close();s=await start({dir,port:0,controlPort:0});assert.deepEqual(await admin('/status'),{events:[],backupDue:[]});
 }finally{await s.close();rmSync(dir,{recursive:true});}
});
