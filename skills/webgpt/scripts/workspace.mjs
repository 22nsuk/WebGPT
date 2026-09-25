import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBytesUpTo } from './bounded-read.mjs';
import { readWindowOptions, textWindow } from './text-window.mjs';

const MAX_BYTES = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function windowsReplacement(action,file,temporary,expectedSha256) {
  const executable=resolve(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const helper=fileURLToPath(new URL('./replace-workspace-file.ps1',import.meta.url));
  const result=spawnSync(executable,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,action],{
    input:JSON.stringify({file,temporary,expectedSha256}),encoding:'utf8',windowsHide:true,maxBuffer:64*1024,
  });
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`Windows permission-preserving replacement failed: ${result.stderr.trim() || result.signal || result.status}`);
}
// Apply one portable Git-metadata policy before filesystem access and when listing.
// Windows aliases include case variants, trailing dots/spaces, GIT~1 and NTFS streams.
const isGitMetadataName = name => /^(?:\.git|git~1)[ .]*(?::|$)/i.test(name);
function relativeFile(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\:\x00-\x1f]/.test(path)
      || path.split('/').some(p => !p.replace(/[ .]+$/, '') || isGitMetadataName(p))) throw Error('invalid path or Git metadata');
  return path;
}
// Relative paths alone cannot protect metadata when the grant itself starts
// inside .git. Check named and native ancestors, including aliases, on each use.
function gitSafeRoot(root) {
  const check = path => {
    if (resolve(path).split(sep).some(isGitMetadataName)) throw Error('invalid workspace root or Git metadata');
  };
  check(root);
  const canonical = realpathSync.native(root);
  check(canonical);
  return canonical;
}
export function grantWorkspace(input) {
  if (input == null) return null;
  if (!input || typeof input.root !== 'string' || !isAbsolute(input.root)
      || !['read','edit'].includes(input.mode) || 'read' in input || 'write' in input) throw Error('use workspace root and mode only');
  if (!input.root.isWellFormed()) throw Error('workspace root must be well-formed Unicode');
  const root = gitSafeRoot(input.root), stat = lstatSync(root);
  if (!stat.isDirectory() || root === parse(root).root || root === realpathSync.native(homedir())) throw Error('project root required');
  return {root, device:stat.dev, inode:stat.ino, mode:input.mode};
}
function target(grant,path,writing=false,createParents=false,directory=false) {
  if (!(directory && path === '.')) relativeFile(path);
  if (!grant || !['read','edit'].includes(grant.mode) || writing && grant.mode!=='edit') throw Error('workspace absent or read-only');
  if ('read' in grant || 'write' in grant) throw Error('legacy file grant; register a project workspace');
  const rootStat = lstatSync(grant.root);
  if (rootStat.isSymbolicLink() || rootStat.dev!==grant.device || rootStat.ino!==grant.inode) throw Error('workspace root changed');
  gitSafeRoot(grant.root); // Recheck retained grants and redirected ancestors before any file access.
  if(directory && path === '.') return grant.root;
  let cursor=grant.root;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++) {
    cursor=resolve(cursor,parts[i]);
    let stat=metadata(cursor);
    if (!stat && i<parts.length-1 && createParents) {mkdirSync(cursor,{mode:0o755});stat=lstatSync(cursor);}
    if (!stat) return resolve(grant.root,path);
    // Reject links before canonicalizing: resolving a link must not erase the evidence.
    if(stat.isSymbolicLink()) throw Error('symlink, hardlink or invalid target type');
    // Native resolution expands actual Windows short names, including aliases other than GIT~1.
    // Check each existing ancestor before creating children or opening a file beneath it.
    cursor=realpathSync.native(cursor);
    if(isGitMetadataName(basename(cursor))) throw Error('invalid path or Git metadata');
    if(i<parts.length-1 || directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink!==1) throw Error('symlink, hardlink or invalid target type');
  }
  return cursor;
}
function snapshot(path) {
  if(!metadata(path)) return {exists:false,text:null,sha256:null};
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.nlink!==1 || stat.size>MAX_BYTES) throw Error('file must be regular, unlinked and <=1 MiB');
    const bytes=readBytesUpTo(fd,MAX_BYTES+1),text=bytes.toString('utf8');
    if(bytes.length>MAX_BYTES || text.includes('\0') || !Buffer.from(text).equals(bytes)) throw Error('UTF-8 text file required');
    return {exists:true,text,sha256:hash(bytes),mode:stat.mode & 0o777};
  } finally {closeSync(fd);}
}
// Optional bounded reads keep the original whole-file snapshot/revision contract.
// Return complete lines (including their original endings); never silently drop a long-line tail.
export function readWorkspace(grant,path,options={}) {
  const range=readWindowOptions(options);
  const result={path,...snapshot(target(grant,path))};
  return range&&result.exists?{...result,...textWindow(result.text,range)}:result;
}
// Readiness needs directory access, not a sorted, revision-hashed listing.
// Keep the same grant/identity/Git-root checks as listWorkspace. Read one entry
// (or EOF for an empty directory), discard it and always close the handle.
// This is not a recursive audit or a guarantee of future read/write access.
export function probeWorkspace(grant) {
  const directory=opendirSync(target(grant,'.',false,false,true),{bufferSize:1});
  try {directory.readSync();} finally {directory.closeSync();}
}
export function listWorkspace(grant,path,{cursor,limit=500}={}) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('limit must be an integer between 1 and 500');
  const directory=target(grant,path,false,false,true);
  const entries=readdirSync(directory,{withFileTypes:true,encoding:'buffer'})
    .map(e=>{
      // Decode without changing the native name. A replacement character can
      // otherwise alias a different file and hide changes from the page cursor.
      const name=e.name.toString('utf8');
      if(!Buffer.from(name).equals(e.name))throw Error('directory entry name must be UTF-8; inspect with native filesystem tools');
      return {name,type:e.isSymbolicLink()?'symlink':e.isDirectory()?'directory':'file'};
    })
    .filter(e=>!isGitMetadataName(e.name))
    // Binary name ordering is deterministic even when locale collation considers two names equal.
    .sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
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
    entries=readdirSync(recovery).filter(name=>name.endsWith('.json')||name.endsWith('.json.tmp')).sort();
  } catch {return {receipts,unresolved:[recovery]};}
  const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
  for(const name of entries) {
    const journal=resolve(recovery,name);
    if(name.endsWith('.json.tmp')) {
      // A staged applied record is evidence, never authority to replay or
      // promote a mutation. A prepared/invalid final journal already diagnoses
      // this operation; otherwise expose even an orphaned or conflicting stage.
      if(!unresolved.includes(journal.slice(0,-4)))unresolved.push(journal);
      continue;
    }
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
      // The path recorded in a receipt is not proof that its original bytes
      // still exist. Reject link-backed originals and verify the actual bytes.
      if(backup!==null) {
        const original=metadata(backup);
        if(!original?.isFile()||original.isSymbolicLink()||original.nlink!==1
            ||snapshot(backup).sha256!==beforeSha256)throw Error('missing or invalid original backup');
      }
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
  const permissions=before.exists?lstatSync(file):null;
  if(!deleting && process.platform!=='win32' && permissions && (permissions.mode & 0o7000))throw Error('editing special-mode files is not supported');
  const recovery=resolve(dir,'recovery',taskId);mkdirSync(recovery,{recursive:true,mode:0o700});
  const operation=randomUUID(), backup=before.exists?resolve(recovery,operation+'.before.txt'):null;
  if(backup) writeFileSync(backup,before.text,{flag:'wx',mode:0o600,flush:true});
  const receipt={operation,path,action:deleting?'delete':before.exists?'edit':'create',beforeSha256:before.sha256,
    afterSha256:deleting?null:hash(text),backup};
  // Persist recovery metadata before changing the project, including on crash.
  const journal=resolve(recovery,operation+'.json');
  writeFileSync(journal,JSON.stringify({...receipt,state:'prepared'}),{flag:'wx',mode:0o600,flush:true});
  if(deleting) {
    target(grant,path,true);
    if(snapshot(file).sha256!==expectedSha256) throw Error('file revision conflict');
    unlinkSync(file);
  } else if(!before.exists) {
    writeFileSync(file,text,{flag:'wx',mode:0o644,flush:true});
  } else {
    const temporary=resolve(dirname(file),'.webgpt-'+operation+'.tmp');
    let created=false, replacementAttempted=false;
    try {
      // Never put replacement bytes into a Windows file with an inherited DACL.
      // POSIX creation also starts private; chmod below applies the exact mode,
      // independently of umask, after chown. Special-mode edits are rejected above.
      if(process.platform==='win32') {
        windowsReplacement('prepare',file,temporary);
        created=true;
      }
      const fd=openSync(temporary,constants.O_RDWR|constants.O_NOFOLLOW
        |(process.platform==='win32'?0:constants.O_CREAT|constants.O_EXCL),0o600);
      created=true;
      try {
        writeFileSync(fd,text);
        if(process.platform!=='win32') {
          const staged=fstatSync(fd);
          if(staged.uid!==permissions.uid || staged.gid!==permissions.gid)fchownSync(fd,permissions.uid,permissions.gid);
          fchmodSync(fd,permissions.mode & 0o777);
          const preserved=fstatSync(fd);
          if(preserved.uid!==permissions.uid || preserved.gid!==permissions.gid
              || (preserved.mode & 0o7777)!==(permissions.mode & 0o777))throw Error('could not preserve file permissions');
        }
        fsyncSync(fd);
      } finally {closeSync(fd);}
      target(grant,path,true);
      if(snapshot(file).sha256!==expectedSha256) throw Error('file revision conflict');
      const current=lstatSync(file);
      if(current.dev!==permissions.dev || current.ino!==permissions.ino || current.mode!==permissions.mode
          || current.uid!==permissions.uid || current.gid!==permissions.gid)throw Error('file permissions or identity changed');
      replacementAttempted=true;
      if(process.platform==='win32')windowsReplacement('replace',file,temporary,expectedSha256);
      else renameSync(temporary,file);
    } finally {
      // ReplaceFile can fail after moving the original or merging its streams.
      // Keep that staging file as evidence alongside the prepared journal.
      // Failed creation does not establish ownership of an existing stage;
      // an unconfirmed Windows preparation also leaves its evidence intact.
      if(created && (process.platform!=='win32'||!replacementAttempted) && metadata(temporary))unlinkSync(temporary);
    }
  }
  // Keep the prepared record intact if writing/flushing the applied state
  // fails. Preserve its temporary file as evidence; never replay this mutation.
  writeFileSync(journal+'.tmp',JSON.stringify({...receipt,state:'applied'}),{flag:'wx',mode:0o600,flush:true});
  renameSync(journal+'.tmp',journal);
  return receipt;
}
