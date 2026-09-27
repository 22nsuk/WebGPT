import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const MAX_DIAGNOSTIC_BYTES=4096, MAX_EXCEPTIONS=4;
const stages={
  prepare:['read_request','read_source_acl','create_private_stage','verify_stage_ownership'],
  replace:['read_request','read_source_acl','verify_stage_ownership','verify_source_revision','native_replace'],
};
// Match the helper's fixed vocabulary. Unknown/custom type names are never copied.
const types=new Set(['unknown','System.Exception','System.IO.IOException',
  'System.IO.FileNotFoundException','System.IO.DirectoryNotFoundException','System.IO.PathTooLongException',
  'System.UnauthorizedAccessException','System.ArgumentException','System.ArgumentNullException',
  'System.NotSupportedException','System.Security.SecurityException','System.ComponentModel.Win32Exception',
  'System.Management.Automation.MethodInvocationException','System.Management.Automation.RuntimeException']);
const processCodes=new Set(['ENOENT','EACCES','EPERM','EAGAIN','EMFILE','ENFILE','ENOMEM','ENOBUFS']);
const int32=value=>Number.isInteger(value)&&value>=-2147483648&&value<=2147483647;
const exactKeys=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function validateEnvelope(value,action) {
  if(!exactKeys(value,['version','action','stage','reason','exceptions','chainTruncated'])
      ||value.version!==1||value.action!==action||!stages[action]?.includes(value.stage)
      ||!['exception','revision_conflict','ownership_mismatch','unknown'].includes(value.reason)
      ||typeof value.chainTruncated!=='boolean'||!Array.isArray(value.exceptions)
      ||value.exceptions.length>MAX_EXCEPTIONS
      ||(value.chainTruncated&&value.exceptions.length!==MAX_EXCEPTIONS)
      ||(value.reason!=='unknown'&&!value.exceptions.length)
      ||(value.reason==='revision_conflict'&&(action!=='replace'||value.stage!=='verify_source_revision'))
      ||(value.reason==='ownership_mismatch'&&value.stage!=='verify_stage_ownership'))return false;
  return value.exceptions.every(entry=>exactKeys(entry,['type','hresult','nativeErrorCode'])
    &&types.has(entry.type)&&(entry.hresult===null||int32(entry.hresult))
    &&(entry.nativeErrorCode===null||(entry.type==='System.ComponentModel.Win32Exception'
      &&int32(entry.nativeErrorCode)&&entry.nativeErrorCode>=0)));
}

function exceptionEvidence(entry) {
  // Decode only the HRESULT_FROM_WIN32 error layout, not arbitrary low bits.
  // A mapped code is not proof that a specific native call produced the error.
  const bits=entry.hresult===null?null:entry.hresult>>>0;
  const mapped=bits!==null&&Math.floor(bits/65536)===0x8007&&(bits&0xffff)!==0?bits&0xffff:null;
  const direct=entry.nativeErrorCode!==null;
  return {type:entry.type,hresult:entry.hresult,nativeErrorCode:entry.nativeErrorCode,
    win32Code:direct?entry.nativeErrorCode:mapped,
    win32Source:direct?'native_error_code':mapped!==null?'hresult_from_win32':null};
}

// Accept only a single bounded helper envelope. Never retain stdout, stderr,
// exception messages, stack, process arguments, paths or a raw Error/cause.
export function diagnoseReplacement(action,result) {
  const knownAction=Object.hasOwn(stages,action)?action:'unknown';
  const diagnostic={version:1,action:knownAction,stage:'unknown',reason:'unknown',
    diagnosticStatus:'missing_output',exitCode:Number.isInteger(result?.status)
      &&result.status>=-2147483648&&result.status<=4294967295?result.status:null,
    processCode:null,exceptions:[],chainTruncated:false};
  if(result?.error) {
    diagnostic.processCode=processCodes.has(result.error.code)?result.error.code:'unknown';
    diagnostic.diagnosticStatus=diagnostic.processCode==='ENOBUFS'?'output_limit':'process_error';
    return diagnostic;
  }
  if(result?.signal) {diagnostic.diagnosticStatus='process_interrupted';return diagnostic;}
  if(diagnostic.exitCode===null||diagnostic.exitCode===0) {
    diagnostic.diagnosticStatus='process_unconfirmed';return diagnostic;
  }
  const text=result?.stderr;
  if(typeof text!=='string'||!text.trim())return diagnostic;
  if(Buffer.byteLength(text)>MAX_DIAGNOSTIC_BYTES) {
    diagnostic.diagnosticStatus='oversized_output';return diagnostic;
  }
  try {
    if(knownAction==='unknown'||(result.stdout!=null&&(typeof result.stdout!=='string'||result.stdout.trim())))throw Error();
    const envelope=JSON.parse(text);
    if(!validateEnvelope(envelope,knownAction))throw Error();
    diagnostic.stage=envelope.stage;diagnostic.reason=envelope.reason;
    diagnostic.exceptions=envelope.exceptions.map(exceptionEvidence);
    diagnostic.chainTruncated=envelope.chainTruncated;
    diagnostic.diagnosticStatus='structured';
  } catch {diagnostic.diagnosticStatus='invalid_output';}
  return diagnostic;
}

export function windowsReplacementFailure(action,result,{recovery,operation}) {
  const diagnostic=diagnoseReplacement(action,result);
  const validOperation=typeof operation==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operation);
  let diagnosticSaved=false;
  try {
    if(!validOperation||typeof recovery!=='string'||!isAbsolute(recovery))throw Error();
    // This is supplementary evidence, NOT a journal or a receipt. Exclusive
    // creation preserves existing entries, including partial writes/flush failures.
    // Windows relies on the same private runtime ACLs as the original backups.
    const text=JSON.stringify({...diagnostic,operation})+'\n';
    if(Buffer.byteLength(text)>MAX_DIAGNOSTIC_BYTES)throw Error();
    writeFileSync(resolve(recovery,operation+'.diagnostic.txt'),text,{flag:'wx',mode:0o600,flush:true});
    diagnosticSaved=true;
  } catch {
    // Diagnostic storage failure must neither replace the original failure nor
    // trigger cleanup, retry, journal promotion or another storage-error state.
  }
  const code='WINDOWS_REPLACEMENT_FAILED';
  const reason=diagnostic.reason==='revision_conflict'?'; file revision conflict'
    :diagnostic.reason==='ownership_mismatch'?'; could not preserve file ownership':'';
  const message=`Windows permission-preserving replacement failed [${code}; action=${diagnostic.action}; stage=${diagnostic.stage}; diagnostic=${diagnostic.diagnosticStatus}; operation=${validOperation?operation:'unknown'}; diagnosticSaved=${diagnosticSaved}; recoveryReviewRequired=true]${reason}`;
  return Object.assign(Error(message),{code,diagnostic,operation:validOperation?operation:null,
    diagnosticSaved,recoveryReviewRequired:true});
}
