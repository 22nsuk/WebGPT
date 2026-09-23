import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { grantWorkspace, readWorkspace, changeWorkspace, inspectRecovery } from './workspace.mjs';

async function fixture(run) {
  const dir=fs.mkdtempSync(join(tmpdir(),'webgpt-permissions-'));
  const root=join(dir,'project');fs.mkdirSync(root);
  const file=join(root,"한글 ' source.txt");fs.writeFileSync(file,'original');
  const grant=grantWorkspace({root,mode:'edit'}), path="한글 ' source.txt";
  try {await run({dir,root,file,grant,path});}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
}
const windows=process.platform==='win32';
const powershell=resolve(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const psArgs=script=>['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(
  "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); "+script,'utf16le').toString('base64')];
function ps(script,data) {
  const result=spawnSync(powershell,psArgs('$request=[Console]::In.ReadToEnd()|ConvertFrom-Json; '+script),
    {input:JSON.stringify(data),encoding:'utf8',windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  return result.stdout.trim()?JSON.parse(result.stdout):null;
}
const evidence=file=>ps(`$acl=[IO.File]::GetAccessControl($request.file);
  @{sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Group,Access');
    protected=$acl.AreAccessRulesProtected;
    users=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -eq 'S-1-5-32-545'}).Count;
    rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {$_.IdentityReference.Value})}|ConvertTo-Json`,{file});

for(const restricted of [true,false])test(`Windows edit preserves ${restricted?'restricted':'inherited'} DACL and owner/group, including private staging`,{skip:!windows},()=>fixture(f=>{
  ps(`$users=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');
    $parent=[IO.Directory]::GetAccessControl($request.root);
    $parent.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($users,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'));
    [IO.Directory]::SetAccessControl($request.root,$parent);
    if($request.restricted){
      $acl=[Security.AccessControl.FileSecurity]::new();$acl.SetAccessRuleProtection($true,$false);
      $user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($user);
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user,'FullControl','Allow'));
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','Allow'));
      [IO.File]::SetAccessControl($request.file,$acl);
    }`,{...f,restricted});
  const before=evidence(f.file);
  assert.equal(before.protected,restricted);
  assert.equal(before.users,restricted?0:1);
  const revision=readWorkspace(f.grant,f.path).sha256;
  const originalWrite=fs.writeFileSync;let staged;
  fs.writeFileSync=(file,...args)=>{
    if(typeof file==='number') {
      const stage=fs.readdirSync(f.root).find(name=>name.startsWith('.webgpt-'));
      assert.ok(stage);assert.equal(fs.statSync(join(f.root,stage)).size,0);
      staged=evidence(join(f.root,stage));
    }
    return originalWrite(file,...args);
  };
  syncBuiltinESMExports();
  let receipt;
  try {receipt=changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'changed 한국어',expectedSha256:revision});}
  finally {fs.writeFileSync=originalWrite;syncBuiltinESMExports();}
  assert.equal(staged.protected,true);assert.equal(staged.users,0);assert.equal(staged.rules.length,1);
  assert.equal(evidence(f.file).sddl,before.sddl);
  assert.equal(fs.readFileSync(f.file,'utf8'),'changed 한국어');
  assert.equal(fs.readFileSync(receipt.backup,'utf8'),'original');
  assert.deepEqual(inspectRecovery(f.dir,'permissions'),{receipts:[receipt],unresolved:[]});
  assert.deepEqual(fs.readdirSync(f.root),[f.path]);
}));

test('Windows native replacement failure preserves original and prepared recovery evidence',{skip:!windows},()=>fixture(async f=>{
  const before=evidence(f.file), revision=readWorkspace(f.grant,f.path).sha256;
  // Hold a real Windows sharing lock that permits reads but forbids deletion.
  const child=spawn(powershell,psArgs(`$stream=[IO.File]::Open($env:WEBGPT_TEST_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
    try{[Console]::Out.WriteLine('ready');[Console]::In.ReadLine()|Out-Null}finally{$stream.Dispose()}`),
    {env:{...process.env,WEBGPT_TEST_FILE:f.file},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');let errors='';child.stderr.on('data',bytes=>errors+=bytes);
  try {
    const ready=await Promise.race([once(child.stdout,'data').then(([data])=>data.toString().trim()),exited.then(()=>{throw Error(errors||'lock child exited');})]);
    assert.equal(ready,'ready');
    assert.throws(()=>changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'changed',expectedSha256:revision}),/permission-preserving replacement failed/);
    assert.equal(fs.readFileSync(f.file,'utf8'),'original');
    assert.equal(evidence(f.file).sddl,before.sddl);
    const recovery=inspectRecovery(f.dir,'permissions');assert.equal(recovery.receipts.length,0);assert.equal(recovery.unresolved.length,1);
    const entry=JSON.parse(fs.readFileSync(recovery.unresolved[0],'utf8'));
    assert.equal(entry.state,'prepared');assert.equal(fs.readFileSync(entry.backup,'utf8'),'original');
    assert.equal(fs.readFileSync(join(f.root,`.webgpt-${entry.operation}.tmp`),'utf8'),'changed');
  } finally {child.stdin.end('\n');await exited;}
}));

test('Windows replacement rechecks revision after helper startup',{skip:!windows},()=>fixture(f=>{
  const revision=readWorkspace(f.grant,f.path).sha256, originalSpawn=childProcess.spawnSync;
  let changed=false;
  childProcess.spawnSync=(command,args,options)=>{
    if(args.at(-1)==='replace') {fs.writeFileSync(f.file,'concurrent edit');changed=true;}
    return originalSpawn(command,args,options);
  };syncBuiltinESMExports();
  try {assert.throws(()=>changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'replacement',expectedSha256:revision}),/revision conflict/);}
  finally {childProcess.spawnSync=originalSpawn;syncBuiltinESMExports();}
  assert.equal(changed,true);assert.equal(fs.readFileSync(f.file,'utf8'),'concurrent edit');
  assert.equal(inspectRecovery(f.dir,'permissions').unresolved.length,1);
}));

test('staging creation collision preserves the unowned file and recovery evidence',()=>fixture(f=>{
  const revision=readWorkspace(f.grant,f.path).sha256;
  const originalOpen=fs.openSync, originalSpawn=childProcess.spawnSync;
  let collision;
  const createCollision=temporary=>{
    collision=temporary;fs.writeFileSync(temporary,'unrelated staging bytes',{flag:'wx'});
  };
  if(windows)childProcess.spawnSync=(command,args,options)=>{
    if(args.at(-1)==='prepare')createCollision(JSON.parse(options.input).temporary);
    return originalSpawn(command,args,options);
  };
  else fs.openSync=(path,flags,...args)=>{
    if(typeof path==='string' && (flags & fs.constants.O_EXCL)
        && path.startsWith(join(f.grant.root,'.webgpt-')))createCollision(path);
    return originalOpen(path,flags,...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(()=>changeWorkspace(f.grant,f.dir,'collision',{path:f.path,text:'changed',expectedSha256:revision}),
      windows?/permission-preserving replacement failed/:{code:'EEXIST'});
  } finally {fs.openSync=originalOpen;childProcess.spawnSync=originalSpawn;syncBuiltinESMExports();}
  assert.ok(collision);assert.equal(fs.readFileSync(collision,'utf8'),'unrelated staging bytes');
  assert.equal(fs.readFileSync(f.file,'utf8'),'original');
  const recovery=inspectRecovery(f.dir,'collision');
  assert.equal(recovery.receipts.length,0);assert.equal(recovery.unresolved.length,1);
  const prepared=JSON.parse(fs.readFileSync(recovery.unresolved[0],'utf8'));
  assert.equal(prepared.state,'prepared');assert.equal(fs.readFileSync(prepared.backup,'utf8'),'original');
}));

test('Windows unconfirmed preparation preserves staging evidence',{skip:!windows},()=>fixture(f=>{
  const revision=readWorkspace(f.grant,f.path).sha256, originalSpawn=childProcess.spawnSync;
  let temporary;
  childProcess.spawnSync=(command,args,options)=>{
    const result=originalSpawn(command,args,options);
    if(args.at(-1)==='prepare') {
      assert.equal(result.status,0,result.stderr);
      temporary=JSON.parse(options.input).temporary;
      // The helper created the file, but its successful completion was not confirmed.
      return {...result,status:1,stderr:'fixture preparation confirmation failure'};
    }
    return result;
  };syncBuiltinESMExports();
  try {assert.throws(()=>changeWorkspace(f.grant,f.dir,'prepare',{path:f.path,text:'changed',expectedSha256:revision}),/fixture preparation confirmation failure/);}
  finally {childProcess.spawnSync=originalSpawn;syncBuiltinESMExports();}
  assert.ok(temporary);assert.equal(fs.readFileSync(temporary,'utf8'),'');
  assert.equal(fs.readFileSync(f.file,'utf8'),'original');
  const recovery=inspectRecovery(f.dir,'prepare');
  assert.equal(recovery.receipts.length,0);assert.equal(recovery.unresolved.length,1);
  const prepared=JSON.parse(fs.readFileSync(recovery.unresolved[0],'utf8'));
  assert.equal(prepared.state,'prepared');assert.equal(fs.readFileSync(prepared.backup,'utf8'),'original');
}));

for(const failure of ['open','write','sync'])test(`owned staging ${failure} failure cleans only its stage and preserves recovery`,
  {skip:failure==='open'&&!windows},()=>fixture(f=>{
    const revision=readWorkspace(f.grant,f.path).sha256, before=fs.statSync(f.file);
    const saved={openSync:fs.openSync,writeFileSync:fs.writeFileSync,fsyncSync:fs.fsyncSync};
    let stagedFd,reached=false;
    const fail=()=>{reached=true;throw Object.assign(Error('fixture staging failure'),{code:'EIO'});};
    fs.openSync=(path,...args)=>{
      const stage=typeof path==='string'&&path.startsWith(join(f.grant.root,'.webgpt-'));
      if(stage&&failure==='open')fail(); // Windows prepare already created this stage.
      const fd=saved.openSync(path,...args);if(stage)stagedFd=fd;return fd;
    };
    fs.writeFileSync=(fd,...args)=>{
      if(failure==='write'&&stagedFd!==undefined&&fd===stagedFd){saved.writeFileSync(fd,'partial');fail();}
      return saved.writeFileSync(fd,...args);
    };
    fs.fsyncSync=fd=>{
      if(failure==='sync'&&stagedFd!==undefined&&fd===stagedFd)fail();
      return saved.fsyncSync(fd);
    };syncBuiltinESMExports();
    try {assert.throws(()=>changeWorkspace(f.grant,f.dir,'stage-failure',{path:f.path,text:'changed',expectedSha256:revision}),{code:'EIO'});}
    finally {Object.assign(fs,saved);syncBuiltinESMExports();}
    assert.equal(reached,true);assert.equal(fs.readFileSync(f.file,'utf8'),'original');
    assert.equal(fs.statSync(f.file).mode,before.mode);assert.deepEqual(fs.readdirSync(f.root),[f.path]);
    const recovery=inspectRecovery(f.dir,'stage-failure');
    assert.equal(recovery.receipts.length,0);assert.equal(recovery.unresolved.length,1);
    const prepared=JSON.parse(fs.readFileSync(recovery.unresolved[0],'utf8'));
    assert.equal(prepared.state,'prepared');assert.equal(fs.readFileSync(prepared.backup,'utf8'),'original');
  }));

for(const mask of [0o000,0o022,0o077])for(const mode of [0o444,0o600,0o664,0o751,0o755])
  test(`POSIX edit preserves mode ${mode.toString(8)} and ownership under umask ${mask.toString(8)}`,{skip:windows},()=>fixture(f=>{
    fs.chmodSync(f.file,mode);const before=fs.statSync(f.file),revision=readWorkspace(f.grant,f.path).sha256;
    const previous=process.umask(mask);let receipt;
    try {receipt=changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'changed',expectedSha256:revision});}
    finally {process.umask(previous);}
    const after=fs.statSync(f.file);
    assert.equal(after.mode & 0o7777,before.mode & 0o7777);assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);
    assert.equal(fs.readFileSync(f.file,'utf8'),'changed');assert.equal(fs.readFileSync(receipt.backup,'utf8'),'original');
    assert.deepEqual(inspectRecovery(f.dir,'permissions'),{receipts:[receipt],unresolved:[]});
  }));

for(const mode of [0o4750,0o2750,0o1750])test(`POSIX special-mode ${mode.toString(8)} edit fails before mutation`,{skip:windows},()=>fixture(f=>{
  fs.chmodSync(f.file,mode);const revision=readWorkspace(f.grant,f.path).sha256;
  assert.throws(()=>changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'changed',expectedSha256:revision}),/special-mode/);
  assert.equal(fs.readFileSync(f.file,'utf8'),'original');assert.equal(fs.statSync(f.file).mode & 0o7777,mode);
  assert.equal(fs.existsSync(join(f.dir,'recovery')),false);assert.deepEqual(fs.readdirSync(f.root),[f.path]);
}));

test('POSIX edit preserves an existing group different from the staging directory',{skip:windows},t=>fixture(f=>{
  const initial=fs.statSync(f.file), group=process.getgroups().find(value=>value!==initial.gid);
  if(group===undefined){t.skip('test account has no alternate supplementary group');return;}
  fs.chownSync(f.file,initial.uid,group);fs.chmodSync(f.file,0o664);
  const revision=readWorkspace(f.grant,f.path).sha256;
  changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'changed',expectedSha256:revision});
  const after=fs.statSync(f.file);
  assert.equal(after.uid,initial.uid);assert.equal(after.gid,group);assert.equal(after.mode & 0o777,0o664);
  assert.equal(fs.readFileSync(f.file,'utf8'),'changed');
}));

test('POSIX permission-restore failure leaves original and backup intact',{skip:windows},()=>fixture(f=>{
  const before=fs.statSync(f.file), revision=readWorkspace(f.grant,f.path).sha256, chmod=fs.fchmodSync;
  fs.fchmodSync=()=>{throw Object.assign(Error('fixture permission failure'),{code:'EPERM'});};syncBuiltinESMExports();
  try {assert.throws(()=>changeWorkspace(f.grant,f.dir,'permissions',{path:f.path,text:'changed',expectedSha256:revision}),/fixture permission failure/);}
  finally {fs.fchmodSync=chmod;syncBuiltinESMExports();}
  assert.equal(fs.readFileSync(f.file,'utf8'),'original');assert.equal(fs.statSync(f.file).mode,before.mode);
  assert.deepEqual(fs.readdirSync(f.root),[f.path]);
  const recovery=inspectRecovery(f.dir,'permissions');assert.equal(recovery.receipts.length,0);assert.equal(recovery.unresolved.length,1);
  assert.equal(fs.readFileSync(JSON.parse(fs.readFileSync(recovery.unresolved[0],'utf8')).backup,'utf8'),'original');
}));
