import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const MAX_BYTES = 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function relativeFile(path) {
  if (typeof path !== 'string' || !path || isAbsolute(path) || /[\\\x00-\x1f]/.test(path)
      || path.split('/').some(p => !p || p === '.' || p === '..' || ['.git','.ssh','.aws','node_modules'].includes(p) || p === '.env' || p.startsWith('.env.'))) throw Error('invalid or protected file path');
  return path;
}
export function grantWorkspace(input) {
  if (input == null) return null;
  if (!input || typeof input.root !== 'string' || !isAbsolute(input.root)
      || !['read','edit'].includes(input.mode) || !Array.isArray(input.read) || !Array.isArray(input.write)
      || input.read.length + input.write.length > 512) throw Error('invalid workspace grant');
  const root = realpathSync(input.root), stat = lstatSync(root);
  if (!stat.isDirectory() || root === sep || root === realpathSync(homedir())) throw Error('project root required');
  if (input.mode === 'read' && input.write.length) throw Error('read-only task cannot grant writes');
  return {root, device:stat.dev, inode:stat.ino, mode:input.mode,
    read:[...new Set(input.read.map(relativeFile))], write:[...new Set(input.write.map(relativeFile))]};
}
export function grantsOverlap(a,b) {
  if (!a || !b) return false;
  const targets = grant => [...grant.read,...grant.write].map(p=>resolve(grant.root,p));
  const intersects = (w, all) => w.some(p=>all.includes(p));
  return intersects(a.write.map(p=>resolve(a.root,p)),targets(b)) || intersects(b.write.map(p=>resolve(b.root,p)),targets(a));
}
function target(grant,path,writing=false,createParents=false) {
  relativeFile(path);
  if (!grant || !(writing ? grant.mode==='edit' && grant.write.includes(path) : [...grant.read,...grant.write].includes(path))) throw Error('file outside task scope');
  const rootStat = lstatSync(grant.root);
  if (rootStat.isSymbolicLink() || rootStat.dev!==grant.device || rootStat.ino!==grant.inode) throw Error('workspace root changed');
  let cursor=grant.root;
  const parts=path.split('/');
  for(let i=0;i<parts.length;i++) {
    cursor=resolve(cursor,parts[i]);
    let stat=metadata(cursor);
    if (!stat && i<parts.length-1 && createParents) {mkdirSync(cursor,{mode:0o755});stat=lstatSync(cursor);}
    if (!stat) return resolve(grant.root,path);
    if(stat.isSymbolicLink() || (i<parts.length-1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink!==1)) throw Error('symlink, hardlink or non-file target rejected');
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
export function changeWorkspace(grant,dir,taskId,{path,text,expectedSha256},deleting=false) {
  if(expectedSha256!==null && (typeof expectedSha256!=='string' || !/^[0-9a-f]{64}$/.test(expectedSha256))) throw Error('expectedSha256 required (null only for create)');
  if(!deleting && (typeof text!=='string' || text.includes('\0') || Buffer.byteLength(text)>MAX_BYTES)) throw Error('text must be <=1 MiB');
  // Validate scope before creating any directory.
  relativeFile(path);
  if(!grant || grant.mode!=='edit' || !grant.write.includes(path)) throw Error('file outside write scope');
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
