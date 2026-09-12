import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { grantWorkspace, listWorkspace, readWorkspace, changeWorkspace } from './workspace.mjs';
import { configuration } from './client.mjs';

const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str = {type:'string'};
export const tools = [
  {name:'list_files',description:'List one directory in the local project. Use path . for the project root. No per-file permission setup.',inputSchema:schema({token:str,path:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_file',description:'Read any text file in the registered local project and its SHA256 revision. Missing file returns exists:false. Use the task token and project-relative path.',inputSchema:schema({token:str,path:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'write_file',description:'Directly create or replace a local project text file. No per-file grants. Read first; expectedSha256 must match its revision, or null for a new file. Original is backed up. No Git or shell.',inputSchema:schema({token:str,path:str,text:str,expectedSha256:{type:['string','null']}}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'delete_file',description:'Directly delete an existing local project file after reading it. Requires matching expectedSha256; original and path are saved for recovery. No directory or recursive deletion.',inputSchema:schema({token:str,path:str,expectedSha256:str}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'get_task',description:'Read the assigned task and input names using its private task token. No repository or Git setup needed.',inputSchema:schema({token:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_input',description:'Read one explicitly supplied input by name; no arbitrary filesystem access.',inputSchema:schema({token:str,name:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'submit_result',description:'Save the task deliverable, evidence and limitations, and notify the supervisor. No file changes required. Terminal: stops backup checks. Retry identical submission safely. Do not delete the chat.',inputSchema:schema({token:str,status:{type:'string',enum:['completed','failed','cancelled']},summary:str,result:str}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
export async function start({dir,port=43137,controlPort=43139,publicMcp=false,backupMs=900000,now=Date.now}={}) {
  dir=resolve(dir); mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=resolve(dir,'worker.lock');
  try{mkdirSync(lock,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw Error('WebGPT data directory locked: '+lock+'; verify its owner before recovering a stale lock');throw e;}
  const release=()=>{if(existsSync(resolve(lock,'owner.json')))unlinkSync(resolve(lock,'owner.json'));rmdirSync(lock);};
  try{
  writeFileSync(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid,host:hostname()}),{mode:0o600});
  const statePath=resolve(dir,'state.json'), keyPath=resolve(dir,'controller.key');
  const key=existsSync(keyPath)?readFileSync(keyPath,'utf8'):randomUUID();
  if(!existsSync(keyPath))writeFileSync(keyPath,key,{mode:0o600,flag:'wx'});
  // URL capability authenticates the remote MCP connection; task tokens separately grant work.
  // Keep the URL out of stdout, task prompts and HTTP error responses.
  let mcpPath='/mcp';
  if(publicMcp){
    const pathKey=resolve(dir,'mcp-path.key');
    if(!existsSync(pathKey))writeFileSync(pathKey,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
    const secret=readFileSync(pathKey,'utf8');
    if(!/^[a-f0-9]{64}$/.test(secret))throw Error('invalid mcp-path.key');
    mcpPath+='/'+secret;
  }
  const tasks=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):[];
  const waiters=new Set();
  const persist=()=>{writeFileSync(statePath+'.tmp',JSON.stringify(tasks),{mode:0o600});renameSync(statePath+'.tmp',statePath);};
  const revoke=t=>{delete t.token;t.inputs={};t.instructions='';};
  // Recover recorded mutations; never guess whether an interrupted mutation was applied.
  for(const t of tasks){
    if(t.collected)revoke(t);
    if(t.status!=='running')continue;
    const recovery=resolve(dir,'recovery',t.id);t.recoveryRequired=[];
    if(!existsSync(recovery))continue;
    for(const name of readdirSync(recovery).filter(n=>n.endsWith('.json'))){
      const journal=resolve(recovery,name);let entry;
      try{entry=JSON.parse(readFileSync(journal,'utf8'));}catch{t.recoveryRequired.push(journal);continue;}
      if(entry.state!=='applied'){t.recoveryRequired.push(journal);continue;}
      if(!(t.changes??=[]).some(c=>c.operation===entry.operation)){const {state,...receipt}=entry;t.changes.push(receipt);}
    }
  }
  if(tasks.length)persist();
  const view=()=>{
    const recoveryRequired=tasks.filter(t=>t.status==='running'&&t.recoveryRequired?.length).map(t=>({id:t.id,journals:t.recoveryRequired}));
    return {events:tasks.filter(t=>t.status!=='running'&&!t.collected).map(t=>({id:t.id,status:t.status,summary:t.summary,artifact:t.artifact,sha256:t.sha256})),backupDue:tasks.filter(t=>t.status==='running'&&now()>=t.nextCheck).map(t=>t.id),...(recoveryRequired.length?{recoveryRequired}:{})};
  };
  const wake=()=>{for(const fn of [...waiters])fn();};
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const body=async req=>{const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>2*1024*1024)throw Error('request too large');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString());};
  const call=(name,args)=>{
    const t=typeof args.token==='string'&&tasks.find(t=>t.token&&t.token===args.token);if(!t)throw Error('unknown task token');
    if(name==='get_task')return {id:t.id,instructions:t.instructions,inputs:Object.keys(t.inputs),status:t.status,workspace:t.workspace??null,changes:t.changes??[],recoveryRequired:t.recoveryRequired??[]};
    if(name==='read_input'){if(!Object.hasOwn(t.inputs,args.name))throw Error('unknown input');return {name:args.name,text:t.inputs[args.name]};}
    if(['list_files','read_file','write_file','delete_file'].includes(name)) {
      if(t.status!=='running')throw Error('task is terminal; file access closed');
      if(name==='list_files')return listWorkspace(t.workspace,args.path);
      if(name==='read_file')return readWorkspace(t.workspace,args.path);
      if(t.recoveryRequired?.length)throw Error('interrupted mutation: supervisor recovery required before further edits');
      const receipt=changeWorkspace(t.workspace,dir,t.id,args,name==='delete_file');
      (t.changes??=[]).push(receipt);persist();return receipt;
    }
    if(name!=='submit_result')throw Error('unknown tool');
    if(!['completed','failed','cancelled'].includes(args.status)||typeof args.result!=='string'||typeof args.summary!=='string'||args.summary.length>2048||Buffer.byteLength(args.result)>1024*1024)throw Error('invalid result');
    if(args.status==='completed'&&t.recoveryRequired?.length)throw Error('supervisor recovery required; preserve partial output with failed status');
    const sha=createHash('sha256').update(args.result).digest('hex');
    if(t.status!=='running'){if(sha!==t.sha256||args.status!==t.status||args.summary!==t.summary)throw Error('terminal result differs');return {accepted:true,duplicate:true,sha256:sha};}
    const artifact=resolve(dir,t.id+'.result.txt');
    writeFileSync(artifact,args.result,{mode:0o600});
    Object.assign(t,{status:args.status,summary:args.summary,artifact,sha256:sha,nextCheck:null});
    persist();wake();return {accepted:true,sha256:sha};
  };
  const mcp=createServer(async(req,res)=>{
    if(req.headers.origin)return json(res,403,{});
    if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,name:'WebGPT Worker'});
    const actual=Buffer.from(req.url??''),expected=Buffer.from(mcpPath);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return json(res,404,{});
    if(req.method!=='POST'){res.setHeader('allow','POST');return json(res,405,{});}
    let m;try{m=await body(req);}catch{return json(res,400,{error:'invalid request'});}
    if(!m||typeof m!=='object'||Array.isArray(m))return json(res,400,{error:'invalid request'});
    if(m.method==='notifications/initialized'){res.writeHead(202);return res.end();}
    let result;
    if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion??'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'webgpt-worker',version:'1.2.1'},instructions:'Read get_task with your private task token and perform the assigned task. Use read_input for supplied inputs. No workspace or file changes are required for text-only work. Use local file tools only when needed and granted; requested edits are applied directly, with revision hashes from read_file and no per-file grants. Review-only tasks cannot write. Coordinate disjoint edits if other workers share the project. Submit result once with the deliverable, any change receipts, evidence and limitations. No Git, PR, shell, or process control. Supervisor verifies results and deletes the chat after collection.'};
    else if(m.method==='tools/list')result={tools};
    else if(m.method==='tools/call'){try{const out=call(m.params.name,m.params.arguments??{});result={content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:false};}catch(e){result={content:[{type:'text',text:e.message}],isError:true};}}
    else return json(res,200,{jsonrpc:'2.0',id:m.id??null,error:{code:-32601,message:'method not found'}});
    json(res,200,{jsonrpc:'2.0',id:m.id??null,result});
  });
  const control=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+key)return json(res,401,{});
    try{
      if(req.method==='GET'&&req.url==='/wait'){
        const v=view();if(v.events.length||v.backupDue.length||v.recoveryRequired?.length||!tasks.some(t=>t.status==='running'))return json(res,200,v);
        let timer;const done=()=>{clearTimeout(timer);waiters.delete(done);if(!res.destroyed)json(res,200,view());};waiters.add(done);
        const due=Math.min(...tasks.filter(t=>t.status==='running').map(t=>t.nextCheck-now()));timer=setTimeout(done,Math.max(1,Math.min(55000,due)));res.on('close',()=>{clearTimeout(timer);waiters.delete(done);});return;
      }
      if(req.method==='GET'&&req.url==='/status')return json(res,200,view());
      if(req.method!=='POST')return json(res,404,{});
      const a=await body(req);
      if(req.url==='/register'){
        if(!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)||tasks.some(t=>t.id===a.id)||typeof a.instructions!=='string'||!a.inputs||typeof a.inputs!=='object'||Array.isArray(a.inputs)||Object.values(a.inputs).some(v=>typeof v!=='string'))throw Error('invalid task');
        const workspace=grantWorkspace(a.workspace);
        const t={id:a.id,token:randomUUID(),instructions:a.instructions,inputs:a.inputs,workspace,changes:[],status:'running',nextCheck:now()+backupMs,collected:false};tasks.push(t);persist();wake();return json(res,200,{id:t.id,token:t.token});
      }
      const t=tasks.find(t=>t.id===a.id);if(!t)throw Error('unknown task');
      if(req.url==='/ack'){if(t.status==='running')throw Error('not complete');t.collected=true;revoke(t);}
      else if(req.url==='/checked'){if(t.status==='running')t.nextCheck=now()+backupMs;}
      else if(req.url==='/cancel'){if(t.status==='running'){t.status='cancelled';t.summary='Cancelled by supervisor';t.nextCheck=null;t.collected=true;revoke(t);}}
      else return json(res,404,{});
      persist();wake();json(res,200,{ok:true});
    }catch(e){json(res,400,{error:e.message});}
  });
  for(const server of [mcp,control])server.requestTimeout=15000;
  const listen=(s,p)=>new Promise((yes,no)=>{s.once('error',no);s.listen(p,'127.0.0.1',yes);});
  try{await listen(mcp,port);await listen(control,controlPort);}catch(e){mcp.close();control.close();throw e;}
  let closed=false;
  return {mcpPort:mcp.address().port,controlPort:control.address().port,key,close:async()=>{if(closed)return;closed=true;wake();await Promise.all([mcp,control].map(s=>new Promise(r=>{s.closeAllConnections();s.close(r);})));release();}};
  }catch(e){release();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  const config=configuration();
  const service=await start({dir:config.dataDir,port:config.mcpPort,controlPort:config.controlPort,publicMcp:config.publicMcp});
  console.log(JSON.stringify({ready:true,mcpPort:service.mcpPort,controlPort:service.controlPort}));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>service.close().then(()=>process.exit(0)));
}
