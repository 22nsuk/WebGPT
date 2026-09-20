# Original backups, journal publication and operational configuration

This supplements [recovery-integrity.md](recovery-integrity.md). It does not add
MCP tools, OS authority, automatic repair or automatic parent/browser resumption.
Keep the worker installation, its configuration and private runtime separate from
delegated project workspaces. Read-only grants prevent mutation, not disclosure.

## Original bytes are part of recovery integrity

An applied edit/delete receipt is recoverable only when its named `.before.txt`
backup is a regular single-link UTF-8 text file within the existing 1 MiB limit,
is not a symlink, and hashes to `beforeSha256`. A valid journal path alone does
not prove the original bytes exist. Creation receipts have no original backup.
The check does not compare an old receipt's `afterSha256` with the current project
file: a later authorized edit may legitimately have changed that file again.

`inspectRecovery` reports the corresponding journal as unresolved when its backup
is missing, changed, invalid or unreadable. The existing worker mechanisms then
block further edits/deletes and successful completion for the affected active
task; reads, evidence inspection and unrelated tasks remain available. A failed
result can still preserve partial output. Restart does not repair the backup.
`reconcile` also checks retained terminal-task journals. A terminal-task backup
issue is shown for inspection without making unrelated active work unready.
A verified result hash and intact mutation backups are separate properties.

Keep all original backups and journals while their receipts are retained. Do not
rotate them as service logs. If a backup is missing or corrupt, preserve state,
remaining backup bytes, journal/candidate files, project contents and retained chat.
Recover originals only from independently verified evidence; do not invent bytes,
remove receipts to clear readiness, or promote an applied candidate automatically.
The parent must reconcile the intended change and actual files before any explicit
recovery or cancellation. This patch provides no repair command.

## Mutation ordering and interrupted publication

Before changing a project file, the worker writes and flushes the original backup
when one exists, then writes and flushes the `prepared` journal. Newly created
project files and replacement tempfiles are also flushed. To publish `applied`,
it writes and flushes a new `<operation>.json.tmp`, then renames it over the
prepared `<operation>.json`. Only then can the receipt be stored in task state.
There is no in-place truncation of the prepared record during applied publication.

A write, flush or rename failure is not a successful operation. The project may
already have changed when applied publication fails. Its prepared record and any
applied temporary file are retained; the task requires inspection rather than
blind replay. A prepared-write failure can itself leave incomplete prepared bytes;
those bytes are evidence, not a valid receipt. An edit replacement tempfile is
still cleaned up by the existing edit failure path; the original project file and
recovery records remain the recovery evidence. No rollback is inferred from an
error response. A surviving `.json.tmp` is also unresolved evidence when its final
journal is absent or already applied. The checker never promotes the staged record
or deletes it; when a prepared/invalid final journal already diagnoses the operation,
it avoids reporting the staged path as a second copy of that warning.

`flush: true` requests Node's `fs.fsyncSync` after writing. This is not an atomic
transaction across project files, runtime files and state. Directory-entry sync,
filesystem/controller behavior, sudden power loss and malicious concurrent path
replacement are not fully covered. The cooperative-local-filesystem boundary is
unchanged. A successful hash check is a point-in-time check, not a storage warranty.

These checks add synchronous I/O and backup hashing. Each recovery inspection can
read all original backups for the selected task(s), and existing receipt comparisons
can be more expensive as task history grows. Do not poll readiness rapidly or assume
unchanged large-task throughput. No mtime-only cache hides missing/modified evidence.
Large-history performance and real power-cut behavior need separate measurement.

## Protect the active configuration, not every project config file

`configurationFile()` resolves the same explicit absolute `WEBGPT_CONFIG`, or the
existing per-user default, used by the worker/controller. The local `start()` API
can supply the corresponding absolute `configFile` when it is embedded or tested;
this option is not exposed to MCP clients or accepted as a task grant.

A project root containing that operational configuration is rejected for both
read and edit grants. Named and canonical paths are checked, including symlink or
directory-alias targets and the nearest existing ancestor of an absent future
configuration file. Existing grants are checked again before file access. Task
metadata stays available for reconciliation/cancellation. An ordinary unrelated
project `config.json` remains editable; there is no filename-wide denylist.

This addresses an unsafe placement, not proof that a particular installation was
compromised. It does not discover arbitrary service XML, tunnel credentials,
executables or other accounts' secrets. Keep those outside every delegated root
with explicit minimal ACLs. An unresolvable config path fails closed; do not add a
bypass to make an unsafe grant work. Inspect and relocate configuration through an
authorized operator workflow, preserving the same intended runtime and settings.

## Transition, verification and rollback

Review the patch against its exact base and deploy the matched worker, client and
workspace module together only after tests. Do not change a running installation
through its own workspace grant. Pause new dispatch, reconcile owned tasks, retain
full results and receipts, and stop the identified worker through its normal local
control path before replacement. Preserve the entire runtime; do not start with an
empty directory to hide a recovery problem.

State, task tokens, result and journal schemas are unchanged. Healthy existing
journals remain compatible. Existing missing or damaged originals now become
visible; treat that as evidence to inspect, not a reason to weaken the validator.
No service registration, account/ACL changes, DNS changes or tunnel changes are
part of this patch. Service recovery still does not resume Codex or browser work.

On the intended Windows account and Node version, validate basic CRUD, stale SHA
rejection, empty originals, edit/delete backups, damaged-backup admission, interrupted
prepared/applied journal publication, active-config isolation, normal service stop,
forced termination and restart. Confirm the existing ChatGPT connector separately.
File-symlink tests may be explicitly skipped if Windows returns EPERM for fixture
creation; that skip is not a successful Windows symlink test and does not authorize
changing Developer Mode, privileges or ACLs.

For rollback, keep the runtime and all evidence produced since the update. Do not
restore an older `state.json` alone. An older binary lacks these backup/configuration
checks and can overwrite a prepared journal during applied publication; returning
to it is not a recovery procedure. Leave the identified service stopped when evidence
cannot be reconciled safely. Revert only reviewed code after compatibility and task
state have been assessed by the operator.

## Primary references

- Node 24 filesystem API (`writeFileSync`, `fsyncSync`, `renameSync`, `lstatSync`):
  https://nodejs.org/docs/latest-v24.x/api/fs.html
- Microsoft, NTFS hard links and junctions:
  https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions

The accompanying review report records the actual test OS/version and NOT_RUN
items. The references above describe API behavior, not installation validation.
