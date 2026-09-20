import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { homedir } from 'node:os';

const MAX_BYTES = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
// Apply one portable Git-metadata policy before filesystem access and when listing.
// Windows aliases include case variants, trailing dots/spaces, GIT~1 and NTFS streams.
const isGitMetadataName = name => /^(?:\.git|git~1)[ .]*(?::|$)/i.test(name);
function relativeFile(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\:\x00-\x1f]/.test(path)
      || path.split('/').some(p => !p.replace(/[ .]+$/, '') || isGitMetadataName(p))) throw Error('invalid path or Git metadata');
  return path;
}
export function grantWorkspace(input) {
  if (input == null) return null;
  if (!input || typeof input.root !== 'string' || !isAbsolute(input.root)
      || !['read','edit'].includes(input.mode) || 'read' in input || 'write' in input) throw Error('use workspace root and mode only');
  const root = realpathSync(input.root), stat = lstatSync(root);
  if (!stat.isDirectory() || root === parse(root).root || root === realpathSync(homedir())) throw Error('project root required');
  return {root, device:stat.dev, inode:stat.ino, mode:input.mode};
}
function target(grant,path,writing=false,createParents=false,directory=false) {
  if (!(directory && path === '.')) relativeFile(path);
  if (!grant || !['read','edit'].includes(grant.mode) || writing && grant.mode!=='edit') throw Error('workspace absent or read-only');
  if ('read' in grant || 'write' in grant) throw Error('legacy file grant; register a project workspace');
  const rootStat = lstatSync(grant.root);
  if (rootStat.isSymbolicLink() || rootStat.dev!==grant.device || rootStat.ino!==grant.inode) throw Error('workspace root changed');
  if(directory && path === '.') return grant.root;
  let cursor=grant.root;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++) {
    cursor=resolve(cursor,parts[i]);
    let stat=metadata(cursor);
    if (!stat && i<parts.length-1 && createParents) {mkdirSync(cursor,{mode:0o755});stat=lstatSync(cursor);}
    if (!stat) return resolve(grant.root,path);
    if(stat.isSymbolicLink() || (i<parts.length-1 || directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink!==1)) throw Error('symlink, hardlink or invalid target type');
  }
  return cursor;
}
function snapshot(path) {
  if(!metadata(path)) return {exists:false,text:null,sha256:null};
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.nlink!==1 || stat.size>MAX_BYTES) throw Error('file must be regular, unlinked and <=1 MiB');
    const bytes=readFileSync(fd),text=bytes.toString('utf8');
    if(bytes.length>MAX_BYTES || text.includes('\0') || !Buffer.from(text).equals(bytes)) throw Error('UTF-8 text file required');
    return {exists:true,text,sha256:hash(bytes),mode:stat.mode & 0o777};
  } finally {closeSync(fd);}
}
export function readWorkspace(grant,path) {return {path,...snapshot(target(grant,path))};}
export function listWorkspace(grant,path,{cursor,limit=500}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('limit must be an integer between 1 and 500');
  const directory=target(grant,path,false,false,true);
  const entries=readdirSync(directory,{withFileTypes:true})
    .filter(e=>!isGitMetadataName(e.name))
    // Binary name ordering is deterministic even when locale collation considers two names equal.
    .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
    .map(e=>({name:e.name,type:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':'file'}));
  const revision=hash(JSON.stringify([grant.root,grant.device,grant.inode,path,entries]));
  let offset=0;
  if(cursor!==undefined) {
    let page;
    try {
      if(typeof cursor!=='string'||cursor.length>256||!cursor||!/^[A-Za-z0-9_-]+$/.test(cursor))throw Error();
      page=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
      if(!page||page.v!==1||!Number.isSafeInteger(page.offset)||page.offset<1||typeof page.revision!=='string')throw Error();
    } catch {throw Error('invalid directory cursor');}
    if(page.revision!==revision)throw Error('directory changed; restart listing without a cursor');
    if(page.offset>=entries.length)throw Error('invalid directory cursor offset');
    offset=page.offset;
  }
  const end=Math.min(offset+limit,entries.length),truncated=end<entries.length;
  return {path,entries:entries.slice(offset,end),truncated,...(truncated?{
    nextCursor:Buffer.from(JSON.stringify({v:1,offset:end,revision})).toString('base64url')
  }: {})};
}
// Read recovery records without replaying mutations. Malformed records belong to
// the affected task, not a reason to disable unrelated tasks in the shared worker.
export function inspectRecovery(dir, taskId) {
  const recoveryRoot=resolve(dir,'recovery'), recovery=resolve(recoveryRoot,taskId), receipts=[], unresolved=[];
  let entries;
  try {
    // Check the shared parent as well: a plain task directory can sit behind a junction/symlink.
    for(const directory of [recoveryRoot,recovery]) {
      const stat=metadata(directory);
      if(!stat)return {receipts,unresolved};
      if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('invalid recovery directory');
    }
    entries=readdirSync(recovery).filter(name=>name.endsWith('.json')).sort();
  } catch {return {receipts,unresolved:[recovery]};}
  const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
  for(const name of entries) {
    const journal=resolve(recovery,name);
    try {
      const stat=metadata(journal);
      if(!stat?.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_BYTES)throw Error('invalid journal file');
      const entry=JSON.parse(snapshot(journal).text);
      if(!entry||typeof entry!=='object'||Array.isArray(entry)||entry.state!=='applied'
          ||typeof entry.operation!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.operation)
          ||name!==entry.operation+'.json')throw Error('unresolved journal');
      const {operation,path,action,beforeSha256,afterSha256,backup}=entry;
      relativeFile(path);
      if(!['create','edit','delete'].includes(action)
          ||(action==='create'?beforeSha256!==null||backup!==null:!digest(beforeSha256)||backup!==resolve(recovery,operation+'.before.txt'))
          ||(action==='delete'?afterSha256!==null:!digest(afterSha256)))throw Error('invalid receipt');
      receipts.push({operation,path,action,beforeSha256,afterSha256,backup});
    } catch {unresolved.push(journal);}
  }
  return {receipts,unresolved};
}

export function changeWorkspace(grant,dir,taskId,{path,text,expectedSha256},deleting=false) {
  if(expectedSha256!==null && (typeof expectedSha256!=='string' || !/^[0-9a-f]{64}$/.test(expectedSha256))) throw Error('expectedSha256 required (null only for create)');
  if(!deleting && (typeof text!=='string' || text.includes('\0') || Buffer.byteLength(text)>MAX_BYTES)) throw Error('text must be <=1 MiB');
  // Validate scope before creating any directory.
  relativeFile(path);
  if(!grant || grant.mode!=='edit') throw Error('workspace absent or read-only');
  const file=target(grant,path,true,!deleting && expectedSha256===null), before=snapshot(file);
  if(before.sha256!==expectedSha256 || deleting && !before.exists) throw Error('file revision conflict; read before changing');
  const recovery=resolve(dir,'recovery',taskId);mkdirSync(recovery,{recursive:true,mode:0o700});
  const operation=randomUUID(), backup=before.exists?resolve(recovery,operation+'.before.txt'):null;
  if(backup) writeFileSync(backup,before.text,{flag:'wx',mode:0o600});
  const receipt={operation,path,action:deleting?'delete':before.exists?'edit':'create',beforeSha256:before.sha256,
    afterSha256:deleting?null:hash(text),backup};
  // Persist recovery metadata before changing the project, including on crash.
  const journal=resolve(recovery,operation+'.json');
  writeFileSync(journal,JSON.stringify({...receipt,state:'prepared'}),{flag:'wx',mode:0o600});
  if(deleting) {
    target(grant,path,true);
    if(snapshot(file).sha256!==expectedSha256) throw Error('file revision conflict');
    unlinkSync(file);
  } else if(!before.exists) {
    writeFileSync(file,text,{flag:'wx',mode:0o644});
  } else {
    const temporary=resolve(dirname(file),'.webgpt-'+operation+'.tmp');
    try {
      writeFileSync(temporary,text,{flag:'wx',mode:before.mode});
      target(grant,path,true);
      if(snapshot(file).sha256!==expectedSha256) throw Error('file revision conflict');
      renameSync(temporary,file);
    } finally { if(metadata(temporary)) unlinkSync(temporary); }
  }
  writeFileSync(journal,JSON.stringify({...receipt,state:'applied'}),{mode:0o600});
  return receipt;
}
