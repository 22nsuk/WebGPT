import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { diagnoseReplacement, windowsReplacementFailure } from './windows-replacement-diagnostics.mjs';
import { inspectRecovery } from './workspace.mjs';
import { start } from './worker.mjs';
import { request } from './client.mjs';

const secret='DO_NOT_DISCLOSE_FIXTURE_SECRET';
const envelope=(extra={})=>({version:1,action:'replace',stage:'native_replace',reason:'exception',
  exceptions:[{type:'System.Management.Automation.MethodInvocationException',hresult:0x80131509|0,nativeErrorCode:null},
    {type:'System.IO.IOException',hresult:0x80070497|0,nativeErrorCode:null}],chainTruncated:false,...extra});
const wire=value=>({status:1,signal:null,stdout:'',stderr:JSON.stringify(value)+'\n'});

// These numerical envelopes are synthetic; they do not reproduce an OS error.
test('nested exception evidence keeps wrapper and HRESULT provenance distinct',()=>{
  const diagnostic=diagnoseReplacement('replace',wire(envelope()));
  assert.equal(diagnostic.diagnosticStatus,'structured');assert.equal(diagnostic.stage,'native_replace');
  assert.equal(diagnostic.exceptions.length,2);assert.equal(diagnostic.exceptions[0].win32Code,null);
  assert.equal(diagnostic.exceptions[1].hresult,0x80070497|0);
  assert.equal(diagnostic.exceptions[1].win32Code,1175);
  assert.equal(diagnostic.exceptions[1].win32Source,'hresult_from_win32');
});

test('only explicit Win32Exception codes or the exact mapped HRESULT layout produce Win32 metadata',()=>{
  const exceptions=[
    {type:'System.ComponentModel.Win32Exception',hresult:0x80004005|0,nativeErrorCode:32},
    {type:'System.IO.IOException',hresult:0x80130497|0,nativeErrorCode:null},
    {type:'unknown',hresult:null,nativeErrorCode:null},
    {type:'System.Exception',hresult:1175,nativeErrorCode:null},
  ];
  const diagnostic=diagnoseReplacement('replace',wire(envelope({exceptions,chainTruncated:true})));
  assert.equal(diagnostic.diagnosticStatus,'structured');assert.equal(diagnostic.chainTruncated,true);
  assert.equal(diagnostic.exceptions[0].win32Code,32);assert.equal(diagnostic.exceptions[0].win32Source,'native_error_code');
  for(const entry of diagnostic.exceptions.slice(1))assert.equal(entry.win32Code,null);
});

test('explicit preparation and revision reasons are accepted only at matching stages',()=>{
  const prepared=diagnoseReplacement('prepare',wire(envelope({action:'prepare',stage:'create_private_stage'})));
  assert.equal(prepared.diagnosticStatus,'structured');assert.equal(prepared.action,'prepare');
  const conflict=diagnoseReplacement('replace',wire(envelope({stage:'verify_source_revision',reason:'revision_conflict'})));
  assert.equal(conflict.reason,'revision_conflict');assert.equal(conflict.stage,'verify_source_revision');
  const unavailable=diagnoseReplacement('replace',wire(envelope({reason:'unknown',exceptions:[]})));
  assert.equal(unavailable.diagnosticStatus,'structured');assert.deepEqual(unavailable.exceptions,[]);
});

for(const [label,value] of [
  ['wrong version',envelope({version:2})],['wrong action',envelope({action:'prepare'})],
  ['wrong stage',envelope({stage:secret})],['inconsistent reason',envelope({reason:'revision_conflict'})],
  ['extra field',envelope({message:secret})],['unknown reason',envelope({reason:secret})],
  ['wrong type',envelope({exceptions:[{type:secret,hresult:1,nativeErrorCode:null}]})],
  ['extra exception field',envelope({exceptions:[{type:'System.Exception',hresult:1,nativeErrorCode:null,stack:secret}]})],
  ['string HRESULT',envelope({exceptions:[{type:'System.Exception',hresult:'0x80070497',nativeErrorCode:null}]})],
  ['out of range HRESULT',envelope({exceptions:[{type:'System.Exception',hresult:2147483648,nativeErrorCode:null}]})],
  ['unproven native code',envelope({exceptions:[{type:'System.IO.IOException',hresult:null,nativeErrorCode:32}]})],
  ['too many exceptions',envelope({exceptions:Array(5).fill(envelope().exceptions[0])})],
  ['incorrect truncation',envelope({chainTruncated:true})],['missing exceptions',envelope({exceptions:[]})],
  ['array envelope',[]],['null envelope',null],
])test(`diagnostic schema rejects ${label} without promoting a stage or copying private data`,()=>{
  const diagnostic=diagnoseReplacement('replace',wire(value));
  assert.equal(diagnostic.diagnosticStatus,'invalid_output');assert.equal(diagnostic.stage,'unknown');
  assert.equal(diagnostic.reason,'unknown');assert.deepEqual(diagnostic.exceptions,[]);
  assert.equal(JSON.stringify(diagnostic).includes(secret),false);
});

for(const [label,result,status] of [
  ['empty',{status:1,stderr:''},'missing_output'],
  ['plain error',{status:1,stderr:'C:\\private\\'+secret},'invalid_output'],
  ['truncated',{status:1,stderr:JSON.stringify(envelope()).slice(0,-2)},'invalid_output'],
  ['oversized',{status:1,stderr:' '.repeat(4096)+'{}'},'oversized_output'],
  ['unexpected stdout',{...wire(envelope()),stdout:secret},'invalid_output'],
  ['spawn failure',{status:null,error:Object.assign(Error(secret),{code:'ENOENT',path:secret})},'process_error'],
  ['unknown process failure',{status:null,error:{code:secret,message:secret}},'process_error'],
  ['output limit',{...wire(envelope()),error:{code:'ENOBUFS',message:secret}},'output_limit'],
  ['signal',{...wire(envelope()),status:null,signal:secret},'process_interrupted'],
  ['unconfirmed exit',{status:null,stderr:JSON.stringify(envelope())},'process_unconfirmed'],
])test(`diagnostic transport classifies ${label} without inferring a native failure`,()=>{
  const diagnostic=diagnoseReplacement('replace',result);
  assert.equal(diagnostic.diagnosticStatus,status);assert.equal(diagnostic.stage,'unknown');
  assert.deepEqual(diagnostic.exceptions,[]);assert.equal(JSON.stringify(diagnostic).includes(secret),false);
});

function recoveryFixture(run) {
  const dir=fs.mkdtempSync(join(tmpdir(),'webgpt-diagnostic-'));
  const recovery=join(dir,'recovery','task');fs.mkdirSync(recovery,{recursive:true,mode:0o700});
  const operation=randomUUID();
  try {return run({dir,recovery,operation});}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('exclusive diagnostic evidence is bounded, private on POSIX, and never a journal',()=>recoveryFixture(context=>{
  const error=windowsReplacementFailure('replace',wire(envelope()),context);
  assert.equal(error.code,'WINDOWS_REPLACEMENT_FAILED');assert.equal(error.diagnosticSaved,true);
  assert.equal(error.recoveryReviewRequired,true);assert.equal(error.cause,undefined);
  assert.equal(error.message.includes(context.recovery),false);
  const path=join(context.recovery,context.operation+'.diagnostic.txt'),bytes=fs.readFileSync(path);
  assert.ok(bytes.length<=4096);assert.equal(JSON.parse(bytes).operation,context.operation);
  if(process.platform!=='win32')assert.equal(fs.statSync(path).mode&0o777,0o600);
  assert.deepEqual(inspectRecovery(context.dir,'task'),{receipts:[],unresolved:[]});
  // A second save cannot overwrite retained evidence, even with different data.
  const duplicate=windowsReplacementFailure('replace',{status:1,stderr:secret},context);
  assert.equal(duplicate.diagnosticSaved,false);assert.deepEqual(fs.readFileSync(path),bytes);
  // Supplementary corrupt data is not mutation authority; real journals still block.
  fs.writeFileSync(join(context.recovery,'partial.diagnostic.txt'),'partial');
  const journal=join(context.recovery,context.operation+'.json');fs.writeFileSync(journal,'{"state":"prepared"}');
  assert.deepEqual(inspectRecovery(context.dir,'task'),{receipts:[],unresolved:[journal]});
}));

for(const timing of ['before_write','after_partial_write'])test(`diagnostic ${timing} failure cannot replace the original failure`,()=>recoveryFixture(context=>{
  const originalWrite=fs.writeFileSync;let attempts=0;
  fs.writeFileSync=(path,text,options)=>{
    if(typeof path==='string'&&path.endsWith('.diagnostic.txt')) {
      attempts++;
      if(timing==='after_partial_write')originalWrite(path,'partial evidence',options);
      throw Object.assign(Error(secret),{code:'ENOSPC'});
    }
    return originalWrite(path,text,options);
  };syncBuiltinESMExports();
  let error;
  try {error=windowsReplacementFailure('replace',wire(envelope()),context);}
  finally {fs.writeFileSync=originalWrite;syncBuiltinESMExports();}
  assert.equal(attempts,1);assert.equal(error.code,'WINDOWS_REPLACEMENT_FAILED');
  assert.equal(error.diagnostic.stage,'native_replace');assert.equal(error.diagnosticSaved,false);
  assert.equal(error.message.includes(secret),false);assert.equal(error.message.includes('ENOSPC'),false);
  const path=join(context.recovery,context.operation+'.diagnostic.txt');
  if(timing==='after_partial_write')assert.equal(fs.readFileSync(path,'utf8'),'partial evidence');
  else assert.equal(fs.existsSync(path),false);
  assert.deepEqual(inspectRecovery(context.dir,'task'),{receipts:[],unresolved:[]});
}));

// Real Worker/MCP and private staging, with injected helper outcomes. These are
// NOT native OS failure reproductions; the actual sharing-lock test is reused
// in workspacePermissions.test.mjs instead of building another lock harness.
for(const failure of ['reported_failure','partial_move','diagnostic_failure','spawn_return','spawn_throw','truncated_output'])
  test(`Windows ${failure} keeps safe MCP errors, quarantine and conditional collection`,{skip:process.platform!=='win32'},async()=>{
    const base=fs.mkdtempSync(join(tmpdir(),'webgpt-diagnostic-worker-'));
    const dir=join(base,'runtime'),root=join(base,'project');fs.mkdirSync(root);
    const path='source-'+secret+'.txt',file=join(root,path);fs.writeFileSync(file,'original');
    const originalSpawn=childProcess.spawnSync,originalWrite=fs.writeFileSync;
    let worker;
    try {
      worker=await start({dir,port:0,controlPort:0,waitMs:20,closeGraceMs:50,configFile:join(base,'config.json')});
      const config={dataDir:dir,controlPort:worker.controlPort};
      const admin=(action,payload)=>request(action,payload,config);
      const call=async(name,args)=>{
        const response=await fetch(`http://127.0.0.1:${worker.mcpPort}/mcp`,{method:'POST',
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
        return (await response.json()).result;
      };
      const register=id=>admin('register',{id,instructions:'fixture',inputs:{},workspace:{root,mode:'edit'}});
      const a=await register('a'),b=await register('b');
      const revision=(await call('read_file',{token:a.token,path})).structuredContent.sha256;
      let prepareCalls=0,replaceCalls=0,diagnosticWrites=0;
      childProcess.spawnSync=(command,args,options)=>{
        if(args.at(-1)==='prepare'){prepareCalls++;return originalSpawn(command,args,options);}
        if(args.at(-1)!=='replace')return originalSpawn(command,args,options);
        replaceCalls++;
        if(failure==='partial_move') {
          // Model an ambiguous partial outcome without claiming an OS error code.
          fs.renameSync(file,join(root,'moved-original.fixture'));
          return wire(envelope({exceptions:[{type:'System.IO.IOException',hresult:null,nativeErrorCode:null}]}));
        }
        if(failure==='spawn_throw')throw Object.assign(Error(secret),{code:'ENOENT',path:file});
        if(failure==='spawn_return')return {status:null,error:Object.assign(Error(secret),{code:'ENOENT',path:file}),stderr:secret};
        if(failure==='truncated_output')return {status:1,stdout:'',stderr:'{"version":1,"message":"'+secret};
        return wire(envelope());
      };
      if(failure==='diagnostic_failure')fs.writeFileSync=(target,text,options)=>{
        if(typeof target==='string'&&target.endsWith('.diagnostic.txt')) {
          diagnosticWrites++;originalWrite(target,'partial diagnostic fixture',options);
          throw Object.assign(Error(secret),{code:'ENOSPC'});
        }
        return originalWrite(target,text,options);
      };
      syncBuiltinESMExports();
      const failed=await call('write_file',{token:a.token,path,text:'replacement',expectedSha256:revision});
      assert.equal(failed.isError,true);const message=failed.content[0].text;
      assert.match(message,/WINDOWS_REPLACEMENT_FAILED/);assert.match(message,/recoveryReviewRequired=true/);
      for(const value of [secret,a.token,root,dir])assert.equal(message.includes(value),false);
      assert.equal(prepareCalls,1);assert.equal(replaceCalls,1);
      const inspected=inspectRecovery(dir,'a');assert.equal(inspected.receipts.length,0);assert.equal(inspected.unresolved.length,1);
      const journal=fs.readFileSync(inspected.unresolved[0]),entry=JSON.parse(journal);
      assert.equal(entry.state,'prepared');assert.equal(fs.readFileSync(entry.backup,'utf8'),'original');
      assert.equal(fs.readFileSync(join(root,`.webgpt-${entry.operation}.tmp`),'utf8'),'replacement');
      const diagnosticPath=join(dir,'recovery','a',entry.operation+'.diagnostic.txt');
      const evidence=fs.readFileSync(diagnosticPath,'utf8');
      assert.equal(evidence.includes(secret),false);assert.ok(Buffer.byteLength(evidence)<=4096);
      if(failure==='diagnostic_failure') {
        assert.equal(diagnosticWrites,1);assert.match(message,/diagnosticSaved=false/);
        assert.equal(evidence,'partial diagnostic fixture');
      } else {
        const diagnostic=JSON.parse(evidence);assert.equal(diagnostic.operation,entry.operation);
        assert.match(message,/diagnosticSaved=true/);
        assert.equal(diagnostic.diagnosticStatus,failure.startsWith('spawn_')?'process_error'
          :failure==='truncated_output'?'invalid_output':'structured');
        assert.equal(diagnostic.stage,failure.startsWith('spawn_')||failure==='truncated_output'?'unknown':'native_replace');
        if(failure==='partial_move')assert.equal(diagnostic.exceptions[0].win32Code,null);
      }
      if(failure==='partial_move') {
        assert.equal(fs.existsSync(file),false);assert.equal(fs.readFileSync(join(root,'moved-original.fixture'),'utf8'),'original');
      } else assert.equal(fs.readFileSync(file,'utf8'),'original');
      const quarantined=(await call('get_task',{token:a.token})).structuredContent;
      assert.equal(quarantined.status,'running');assert.equal(quarantined.recoveryRequired.length,1);
      assert.equal((await call('write_file',{token:a.token,path:'blocked.txt',text:'x',expectedSha256:null})).isError,true);
      assert.equal(fs.existsSync(join(root,'blocked.txt')),false);
      assert.equal((await call('submit_result',{token:a.token,status:'completed',summary:'fixture',result:'partial'})).isError,true);
      assert.equal(replaceCalls,1);assert.deepEqual(fs.readFileSync(inspected.unresolved[0]),journal);
      const reconciliation=await admin('reconcile',{ids:['a','b']});
      assert.equal(reconciliation.health.storage.ok,true);
      assert.deepEqual(reconciliation.tasks.find(task=>task.id==='b').recoveryRequired,[]);
      const submitted=await call('submit_result',{token:a.token,status:'failed',summary:'fixture',result:'preserved partial result'});
      assert.equal(submitted.isError,false);
      await assert.rejects(admin('collect',{id:'a',expectedStatus:'failed',expectedSha256:submitted.structuredContent.sha256}),/recovery/i);
      assert.equal((await call('write_file',{token:b.token,path:'other.txt',text:'other',expectedSha256:null})).isError,false);
      const normal=await call('submit_result',{token:b.token,status:'completed',summary:'fixture',result:'normal result'});
      assert.equal(normal.isError,false);
      assert.equal((await admin('collect',{id:'b',expectedStatus:'completed',expectedSha256:normal.structuredContent.sha256})).collected,true);
    } finally {
      childProcess.spawnSync=originalSpawn;fs.writeFileSync=originalWrite;syncBuiltinESMExports();
      await worker?.close();fs.rmSync(base,{recursive:true,force:true});
    }
  });
