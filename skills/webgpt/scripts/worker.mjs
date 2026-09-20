import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { grantWorkspace, listWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';
import { configuration } from './client.mjs';
import { protocolVersions, validateMessage, negotiateProtocol, validateArguments } from './protocol.mjs';

const schema = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const str = {type:'string'};
export const tools = [
  {name:'list_files',description:'List a local project directory, up to 500 entries per page. Use path . for the root. Pass nextCursor as cursor for the next page; restart without a cursor if the directory changes.',inputSchema:{...schema({token:str,path:str}),properties:{token:str,path:str,cursor:str,limit:{type:'integer',minimum:1,maximum:500}}},annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_file',description:'Read any text file in the registered local project and its SHA256 revision. Missing file returns exists:false. Use the task token and project-relative path.',inputSchema:schema({token:str,path:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'write_file',description:'Directly create or replace a local project text file. No per-file grants. Read first; expectedSha256 must match its revision, or null for a new file. Original is backed up. No Git or shell.',inputSchema:schema({token:str,path:str,text:str,expectedSha256:{type:['string','null']}}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'delete_file',description:'Directly delete an existing local project file after reading it. Requires matching expectedSha256; original and path are saved for recovery. No directory or recursive deletion.',inputSchema:schema({token:str,path:str,expectedSha256:str}),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'get_task',description:'Read the assigned task and input names using its private task token. No repository or Git setup needed.',inputSchema:schema({token:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'read_input',description:'Read one explicitly supplied input by name; no arbitrary filesystem access.',inputSchema:schema({token:str,name:str}),annotations:{readOnlyHint:true,openWorldHint:false}},
  {name:'submit_result',description:'Save the task deliverable, evidence and limitations, and notify the supervisor. No file changes required. Terminal: stops backup checks. Retry identical submission safely. Do not delete the chat.',inputSchema:schema({token:str,status:{type:'string',enum:['completed','failed','cancelled']},summary:str,result:str}),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}}
];
export async function start({dir,port=43137,controlPort=43139,publicMcp=false,backupMs=900000,waitMs=55000,now=Date.now}={}) {
  if(!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>55000)throw Error('waitMs must be between 1 and 55000');
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
  let tasks=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):[];
  // Do not silently reinterpret live upstream terminal/open grants as file tasks.
  if(tasks.some(t=>!t.collected&&['terminal','mode','openKey'].some(key=>Object.hasOwn(t,key))))
    throw Error('incompatible terminal/open state; use its matching worker to retire active sessions first');
  const waiters=new Set();
  // Publish in-memory transitions only after the matching state file was replaced.
  // A failed write must not turn a later retry into a false success or revoke a token.
  const persist=(next=tasks)=>{
    writeFileSync(statePath+'.tmp',JSON.stringify(next),{mode:0o600});
    renameSync(statePath+'.tmp',statePath);
    tasks=next;
  };
  const updateTask=(task,changes)=>persist(tasks.map(t=>t===task?{...t,...changes}:t));
  const checkDataBoundary=workspace=>{
    if(!workspace)return;
    const dataRoot=realpathSync.native(dir), workspaceRoot=realpathSync.native(workspace.root);
    // Neither tree may contain the other: runtime descendants include private recovery copies.
    for(const rel of [relative(workspaceRoot,dataRoot),relative(dataRoot,workspaceRoot)])
      if(rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep)))
        throw Error('workspace overlaps private worker data; use a separate project root');
  };
  const revoke=t=>{delete t.token;t.inputs={};t.instructions='';};
  // Recover recorded mutations; never guess whether an interrupted mutation was applied.
  for(const t of tasks){
    if(t.collected)revoke(t);
    if(t.status!=='running')continue;
    const {receipts,unresolved}=inspectRecovery(dir,t.id);
    t.recoveryRequired=unresolved;
    for(const receipt of receipts) {
      const existing=(t.changes??=[]).find(c=>c.operation===receipt.operation);
      if(!existing)t.changes.push(receipt);
      else if(!isDeepStrictEqual(existing,receipt))
        t.recoveryRequired.push(resolve(dir,'recovery',t.id,receipt.operation+'.json'));
    }
  }
  if(tasks.length)persist();
  const view=(selected=tasks)=>{
    const recoveryRequired=selected.filter(t=>t.status==='running'&&t.recoveryRequired?.length).map(t=>({id:t.id,journals:t.recoveryRequired}));
    return {events:selected.filter(t=>t.status!=='running'&&!t.collected).map(t=>({id:t.id,status:t.status,summary:t.summary,artifact:t.artifact,sha256:t.sha256})),backupDue:selected.filter(t=>t.status==='running'&&now()>=t.nextCheck).map(t=>t.id),...(recoveryRequired.length?{recoveryRequired}:{})};
  };
  const wake=()=>{for(const fn of [...waiters])fn();};
  const flagUnrecordedChanges=task=>{
    const {receipts,unresolved}=inspectRecovery(dir,task.id);
    const pending=new Set([...(task.recoveryRequired??[]),...unresolved]);
    for(const receipt of receipts)
      if(!task.changes?.some(c=>isDeepStrictEqual(c,receipt)))
        pending.add(resolve(dir,'recovery',task.id,receipt.operation+'.json'));
    // This safety block intentionally stays live even if state storage is unavailable.
    if(pending.size){task.recoveryRequired=[...pending];wake();}
  };
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const body=async(req,limit=2*1024*1024)=>{
    const chunks=[];let bytes=0;
    for await(const c of req){bytes+=c.length;if(bytes>limit)throw Object.assign(Error('request too large'),{statusCode:413});chunks.push(c);}
    // Reject invalid wire bytes rather than silently substituting replacement characters.
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  };
  const call=(name,args)=>{
    if(!args||typeof args!=='object'||Array.isArray(args))throw Error('tool arguments must be an object');
    const t=typeof args.token==='string'&&tasks.find(t=>t.token&&t.token===args.token);if(!t)throw Error('unknown task token');
    const tool=tools.find(tool=>tool.name===name);if(!tool)throw Error('unknown tool');
    if(['list_files','read_file','write_file','delete_file'].includes(name))checkDataBoundary(t.workspace);
    validateArguments(tool,args);
    if(name==='get_task')return {id:t.id,instructions:t.instructions,inputs:Object.keys(t.inputs),status:t.status,workspace:t.workspace??null,changes:t.changes??[],recoveryRequired:t.recoveryRequired??[]};
    if(name==='read_input'){if(!Object.hasOwn(t.inputs,args.name))throw Error('unknown input');return {name:args.name,text:t.inputs[args.name]};}
    if(['list_files','read_file','write_file','delete_file'].includes(name)) {
      if(t.status!=='running')throw Error('task is terminal; file access closed');
      if(name==='list_files')return listWorkspace(t.workspace,args.path,{cursor:args.cursor,limit:args.limit});
      if(name==='read_file')return readWorkspace(t.workspace,args.path);
      if(t.recoveryRequired?.length)throw Error('interrupted mutation: supervisor recovery required before further edits');
      try {
        const receipt=changeWorkspace(t.workspace,dir,t.id,args,name==='delete_file');
        updateTask(t,{changes:[...(t.changes??[]),receipt]});
        return receipt;
      } catch(e) {
        flagUnrecordedChanges(t);
        if(t.recoveryRequired?.length)throw Error('file operation not fully recorded; supervisor recovery required: '+e.message);
        throw e;
      }
    }
    if(name!=='submit_result')throw Error('unknown tool');
    if(!['completed','failed','cancelled'].includes(args.status)||typeof args.result!=='string'||typeof args.summary!=='string'||args.summary.length>2048||Buffer.byteLength(args.result)>1024*1024)throw Error('invalid result');
    if(args.status==='completed'&&t.recoveryRequired?.length)throw Error('supervisor recovery required; preserve partial output with failed status');
    const sha=createHash('sha256').update(args.result).digest('hex');
    if(t.status!=='running'){if(sha!==t.sha256||args.status!==t.status||args.summary!==t.summary)throw Error('terminal result differs');return {accepted:true,duplicate:true,sha256:sha};}
    const artifact=resolve(dir,t.id+'.result.txt');
    writeFileSync(artifact+'.tmp',args.result,{mode:0o600});
    renameSync(artifact+'.tmp',artifact);
    updateTask(t,{status:args.status,summary:args.summary,artifact,sha256:sha,nextCheck:null});
    wake();return {accepted:true,sha256:sha};
  };
  const mcp=createServer(async(req,res)=>{
    if(req.headers.origin)return json(res,403,{});
    if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,name:'WebGPT Worker'});
    const actual=Buffer.from(req.url??''),expected=Buffer.from(mcpPath);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return json(res,404,{});
    if(req.method!=='POST'){res.setHeader('allow','POST');return json(res,405,{});}
    const error=(status,id,code,message)=>json(res,status,{jsonrpc:'2.0',id,error:{code,message}});
    const version=req.headers['mcp-protocol-version'];
    if(version!==undefined&&!protocolVersions.includes(version))return error(400,null,-32600,'unsupported MCP protocol header');
    // JSON escaping can expand a valid 1 MiB text payload to 6 MiB plus its envelope.
    // The decoded per-file/result limits remain 1 MiB; controller bodies remain 2 MiB.
    let m;try{m=await body(req,8*1024*1024);}catch(e){
      return error(e.statusCode??400,null,e.statusCode===413?-32600:-32700,e.statusCode===413?'request too large':'invalid JSON or UTF-8');
    }
    let kind;try{kind=validateMessage(m);}catch{return error(400,null,-32600,'invalid JSON-RPC request');}
    if(kind==='notification'){res.writeHead(202);return res.end();}
    let result,protocolVersion;
    if(m.method==='initialize') {
      try{protocolVersion=negotiateProtocol(m.params?.protocolVersion);}catch{return error(200,m.id,-32602,'invalid protocolVersion');}
    }
    if(m.method==='ping')result={};
    else if(m.method==='initialize')result={protocolVersion,capabilities:{tools:{}},serverInfo:{name:'webgpt-worker',version:'1.4.1-fork.2'},instructions:'Read get_task with your private task token and perform the assigned task. Use read_input for supplied inputs. No workspace or file changes are required for text-only work. Use local file tools only when needed and granted; requested edits are applied directly, with revision hashes from read_file and no per-file grants. Review-only tasks cannot write. Coordinate disjoint edits if other workers share the project. Submit result once with the deliverable, any change receipts, evidence and limitations. No Git, PR, shell, or process control. Supervisor verifies results and retains task chats by default. Delete a task chat only when the user explicitly requests deletion of that chat.'};
    else if(m.method==='tools/list')result={tools};
    else if(m.method==='tools/call'){try{const out=call(m.params?.name,m.params?.arguments);result={content:[{type:'text',text:JSON.stringify(out)}],structuredContent:out,isError:false};}catch(e){result={content:[{type:'text',text:e.message}],isError:true};}}
    else return json(res,200,{jsonrpc:'2.0',id:m.id??null,error:{code:-32601,message:'method not found'}});
    json(res,200,{jsonrpc:'2.0',id:m.id??null,result});
  });
  const control=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+key)return json(res,401,{});
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/wait'){
        const ids=url.searchParams.getAll('id');
        if([...url.searchParams.keys()].some(key=>key!=='id'))throw Error('invalid wait query');
        if(ids.some(id=>!tasks.some(t=>t.id===id)))throw Error('unknown task');
        const selected=()=>ids.length?tasks.filter(t=>ids.includes(t.id)):tasks;
        const snapshot=()=>({...view(selected()),...(ids.length?{settled:!selected().some(t=>t.status==='running')}:{})});
        const ready=v=>v.events.length||v.backupDue.length||v.recoveryRequired?.length||!selected().some(t=>t.status==='running');
        const v=snapshot();if(ready(v))return json(res,200,v);
        let timer;
        const done=(timeout=false)=>{
          const v=snapshot();
          if(!timeout&&!ready(v))return; // An unrelated task must not wake this wait.
          clearTimeout(timer);waiters.delete(done);
          if(!res.destroyed)json(res,200,v);
        };
        waiters.add(done);
        const due=Math.min(...selected().filter(t=>t.status==='running').map(t=>t.nextCheck-now()));
        timer=setTimeout(()=>done(true),Math.max(1,Math.min(waitMs,due)));
        res.on('close',()=>{clearTimeout(timer);waiters.delete(done);});return;
      }
      if(req.method==='GET'&&req.url==='/status')return json(res,200,view());
      if(req.method==='GET'&&req.url==='/tasks') {
        const active=tasks.filter(t=>t.status==='running'||!t.collected);
        return json(res,200,{running:active.filter(t=>t.status==='running').length,
          uncollected:active.filter(t=>t.status!=='running'&&!t.collected).length,
          tasks:active.map(t=>({id:t.id,status:t.status,collected:t.collected,nextCheck:t.nextCheck,
            workspace:t.workspace?{root:t.workspace.root,mode:t.workspace.mode}:null,
            recoveryRequired:Boolean(t.recoveryRequired?.length)}))});
      }

      if(req.method!=='POST')return json(res,404,{});
      const a=await body(req);
      if(req.url==='/register'){
        if(a&&['terminal','mode'].some(key=>Object.hasOwn(a,key)))throw Error('terminal/open modes are not supported by this file-scoped fork');
        if(!a||typeof a.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(a.id)||typeof a.instructions!=='string'||!a.inputs||typeof a.inputs!=='object'||Array.isArray(a.inputs)||Object.values(a.inputs).some(v=>typeof v!=='string'))throw Error('invalid task');
        // IDs become result/recovery filenames, so keep them portable across Windows and POSIX.
        if(/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(a.id))throw Error('invalid task ID: reserved Windows filename');
        const workspace=grantWorkspace(a.workspace);
        checkDataBoundary(workspace);
        const existing=tasks.find(t=>t.id===a.id);
        if(!existing&&tasks.some(t=>typeof t.id==='string'&&t.id.toLowerCase()===a.id.toLowerCase()))
          throw Error('task ID conflicts with an existing ID on case-insensitive filesystems');
        if(existing) {
          if(existing.status==='running'&&!existing.collected&&existing.token&&existing.instructions===a.instructions
              &&isDeepStrictEqual(existing.inputs,a.inputs)
              &&isDeepStrictEqual(existing.workspace?{...existing.workspace,root:realpathSync.native(existing.workspace.root)}:null,workspace))
            return json(res,200,{id:existing.id,token:existing.token,duplicate:true});
          throw Error('task ID already exists with different inputs, grant or terminal state');
        }
        const t={id:a.id,token:randomUUID(),instructions:a.instructions,inputs:a.inputs,workspace,changes:[],status:'running',nextCheck:now()+backupMs,collected:false};
        persist([...tasks,t]);wake();return json(res,200,{id:t.id,token:t.token});
      }
      const t=tasks.find(t=>t.id===a.id);if(!t)throw Error('unknown task');
      const next={...t};
      if(req.url==='/ack'){if(t.status==='running')throw Error('not complete');next.collected=true;revoke(next);}
      else if(req.url==='/checked'){if(t.status==='running')next.nextCheck=now()+backupMs;}
      else if(req.url==='/cancel'){
        if(t.status==='running'){next.status='cancelled';next.summary='Cancelled by supervisor';next.nextCheck=null;next.collected=true;revoke(next);}
        // Abandon collection explicitly without rewriting the terminal result or its evidence.
        else if(!t.collected){next.collected=true;next.discarded=true;revoke(next);}
      }
      else return json(res,404,{});
      persist(tasks.map(task=>task===t?next:task));wake();json(res,200,{ok:true});
    }catch(e){json(res,400,{error:e.message});}
  });
  for(const server of [mcp,control])server.requestTimeout=15000;
  const listen=(s,p)=>new Promise((yes,no)=>{s.once('error',no);s.listen(p,'127.0.0.1',yes);});
  try{await listen(mcp,port);await listen(control,controlPort);}catch(e){mcp.close();control.close();throw e;}
  let closed=false;
  return {mcpPort:mcp.address().port,controlPort:control.address().port,key,close:async()=>{if(closed)return;closed=true;wake();await Promise.all([mcp,control].map(s=>new Promise(r=>{s.closeAllConnections();s.close(r);})));release();}};
  }catch(e){release();throw e;}
}
if(process.argv[1]&&process.argv[1]!=='-'&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  const config=configuration();
  const service=await start({dir:config.dataDir,port:config.mcpPort,controlPort:config.controlPort,publicMcp:config.publicMcp});
  console.log(JSON.stringify({ready:true,mcpPort:service.mcpPort,controlPort:service.controlPort}));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>service.close().then(()=>process.exit(0)));
}
