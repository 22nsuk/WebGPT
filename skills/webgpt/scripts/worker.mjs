import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { grantWorkspace, grantsOverlap, readWorkspace, changeWorkspace } from './workspace.mjs';

const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str = {type:'string'};
export const tools = [
  {name:'read_file',description:'Read a task-owned local project text file and its SHA256 revision. Missing allowed file returns exists:false. Use the task token and a granted relative path.',inputSchema:schema({token:str,path:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'write_file',description:'Directly create or replace a task-owned local project file. Read first; expectedSha256 must match its revision, or null for a new file. Original is backed up. No Git or shell.',inputSchema:schema({token:str,path:str,text:str,expectedSha256:{type:['string','null']}}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'delete_file',description:'Directly delete an existing task-owned project file after reading it. Requires matching expectedSha256; original and path are saved for recovery. No directory or recursive deletion.',inputSchema:schema({token:str,path:str,expectedSha256:str}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'get_task',description:'Read the assigned task and input names using its private task token. No repository or Git setup needed.',inputSchema:schema({token:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_input',description:'Read one explicitly supplied input by name; no arbitrary filesystem access.',inputSchema:schema({token:str,name:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'submit_result',description:'Save the complete result (report or code patch) and notify the supervisor. Terminal: stops backup checks. Retry identical submission safely. Do not delete the chat.',inputSchema:schema({token:str,status:{type:'string',enum:['completed','failed','cancelled']},summary:str,result:str}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
export async function start({dir,port=43137,controlPort=43139,backupMs=900000}={}) {
  dir=resolve(dir); mkdirSync(dir,{recursive:true,mode:0o700});
  const statePath=resolve(dir,'state.json'), keyPath=resolve(dir,'controller.key');
  const key=existsSync(keyPath)?readFileSync(keyPath,'utf8'):randomUUID();
  if(!existsSync(keyPath))writeFileSync(keyPath,key,{mode:0o600,flag:'wx'});
  const tasks=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):[];
  const waiters=new Set();
  const persist=()=>{writeFileSync(statePath+'.tmp',JSON.stringify(tasks),{mode:0o600});renameSync(statePath+'.tmp',statePath);};
  const view=()=>({events:tasks.filter(t=>t.status!=='running'&&!t.collected).map(t=>({id:t.id,status:t.status,summary:t.summary,artifact:t.artifact,sha256:t.sha256})),backupDue:tasks.filter(t=>t.status==='running'&&Date.now()>=t.nextCheck).map(t=>t.id)});
  const wake=()=>{for(const fn of [...waiters])fn();};
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const body=async req=>{const chunks=[];let bytes=0;for await(const c of req){bytes+=c.length;if(bytes>2*1024*1024)throw Error('request too large');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString());};
  const call=(name,args)=>{
    const t=tasks.find(t=>t.token===args.token);if(!t)throw Error('unknown task token');
    if(name==='get_task')return {id:t.id,instructions:t.instructions,inputs:Object.keys(t.inputs),status:t.status,workspace:t.workspace??null,changes:t.changes??[]};
    if(name==='read_input'){if(!Object.hasOwn(t.inputs,args.name))throw Error('unknown input');return {name:args.name,text:t.inputs[args.name]};}
    if(['read_file','write_file','delete_file'].includes(name)) {
      if(t.status!=='running')throw Error('task is terminal; file access closed');
      if(name==='read_file')return readWorkspace(t.workspace,args.path);
      const receipt=changeWorkspace(t.workspace,dir,t.id,args,name==='delete_file');
      (t.changes??=[]).push(receipt);persist();return receipt;
    }
    if(name!=='submit_result')throw Error('unknown tool');
    if(!['completed','failed','cancelled'].includes(args.status)||typeof args.result!=='string'||typeof args.summary!=='string'||args.summary.length>2048||Buffer.byteLength(args.result)>1024*1024)throw Error('invalid result');
    const sha=createHash('sha256').update(args.result).digest('hex');
    if(t.status!=='running'){if(sha!==t.sha256||args.status!==t.status||args.summary!==t.summary)throw Error('terminal result differs');return {accepted:true,duplicate:true,sha256:sha};}
    const artifact=resolve(dir,t.id+'.result.txt');
    writeFileSync(artifact,args.result,{mode:0o600});
    Object.assign(t,{status:args.status,summary:args.summary,artifact,sha256:sha,nextCheck:null});
    persist();wake();return {accepted:true,sha256:sha};
  };
  const mcp=createServer(async(req,res)=>{
    if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,name:'WebGPT Worker'});
    if(req.method!=='POST'||req.url!=='/mcp')return json(res,404,{});
    let m;try{m=await body(req);}catch{return json(res,400,{error:'invalid request'});}
    if(m.method==='notifications/initialized'){res.writeHead(202);return res.end();}
    let result;
    if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion??'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'webgpt-worker',version:'1.1.0'},instructions:'Read get_task with your private task token. For implementation, directly read/create/edit/delete granted local files; use revision hashes from read_file. Review-only grants cannot write. Submit result once with change receipts, evidence and limitations. No Git, PR, shell, or process control. Supervisor verifies results and deletes the chat after collection.'};
    else if(m.method==='tools/list')result={tools};
    else if(m.method==='tools/call'){try{const out=call(m.params.name,m.params.arguments??{});result={content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:false};}catch(e){result={content:[{type:'text',text:e.message}],isError:true};}}
    else return json(res,200,{jsonrpc:'2.0',id:m.id??null,error:{code:-32601,message:'method not found'}});
    json(res,200,{jsonrpc:'2.0',id:m.id??null,result});
  });
  const control=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+key)return json(res,401,{});
    try{
      if(req.method==='GET'&&req.url==='/wait'){
        const v=view();if(v.events.length||v.backupDue.length)return json(res,200,v);
        let timer;const done=()=>{clearTimeout(timer);waiters.delete(done);if(!res.destroyed)json(res,200,view());};waiters.add(done);
        const due=Math.min(...tasks.filter(t=>t.status==='running').map(t=>t.nextCheck-Date.now()));timer=setTimeout(done,Math.max(1,Math.min(55000,due)));res.on('close',()=>{clearTimeout(timer);waiters.delete(done);});return;
      }
      if(req.method==='GET'&&req.url==='/status')return json(res,200,view());
      if(req.method!=='POST')return json(res,404,{});
      const a=await body(req);
      if(req.url==='/register'){
        if(!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)||tasks.some(t=>t.id===a.id)||typeof a.instructions!=='string'||!a.inputs||typeof a.inputs!=='object'||Array.isArray(a.inputs)||Object.values(a.inputs).some(v=>typeof v!=='string'))throw Error('invalid task');
        const workspace=grantWorkspace(a.workspace);
        if(tasks.some(t=>t.status==='running' && grantsOverlap(workspace,t.workspace)))throw Error('workspace ownership overlaps active task');
        const t={id:a.id,token:randomUUID(),instructions:a.instructions,inputs:a.inputs,workspace,changes:[],status:'running',nextCheck:Date.now()+backupMs,collected:false};tasks.push(t);persist();wake();return json(res,200,{id:t.id,token:t.token});
      }
      const t=tasks.find(t=>t.id===a.id);if(!t)throw Error('unknown task');
      if(req.url==='/ack'){if(t.status==='running')throw Error('not complete');t.collected=true;}
      else if(req.url==='/checked'){if(t.status==='running')t.nextCheck=Date.now()+backupMs;}
      else if(req.url==='/cancel'){if(t.status==='running'){t.status='cancelled';t.summary='Cancelled by supervisor';t.nextCheck=null;t.collected=true;}}
      else return json(res,404,{});
      persist();wake();json(res,200,{ok:true});
    }catch(e){json(res,400,{error:e.message});}
  });
  for(const server of [mcp,control])server.requestTimeout=15000;
  const listen=(s,p)=>new Promise((yes,no)=>{s.once('error',no);s.listen(p,'127.0.0.1',yes);});
  try{await listen(mcp,port);await listen(control,controlPort);}catch(e){mcp.close();control.close();throw e;}
  return {mcpPort:mcp.address().port,controlPort:control.address().port,key,close:async()=>{wake();await Promise.all([mcp,control].map(s=>new Promise(r=>{s.closeAllConnections();s.close(r);})));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const service=await start({dir:process.env.WEBGPT_DATA_DIR??resolve(import.meta.dirname,'data')});
  console.log(JSON.stringify({ready:true,mcpPort:service.mcpPort,controlPort:service.controlPort}));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>service.close().then(()=>process.exit(0)));
}
