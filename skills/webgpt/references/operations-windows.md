# Windows operation and recovery

Service recovery is not task, ChatGPT or parent-Codex resumption. This file is an
operating contract, not permission to install a service, change ACLs/accounts,
register a scheduled task, alter DNS, replace credentials or bypass an approval
refusal. Existing deployments must be changed only in an authorized maintenance
window. The MCP interface remains the same seven project-text tools; none of the
local lifecycle commands below is delegated through MCP.

## Components and ownership

Use one identified worker per private, local-disk data directory. Keep the worker,
client, runtime helper and trusted service launcher on the same reviewed revision.
The optional `scripts/service.mjs run` launcher starts only its sibling `worker.mjs`
with the current absolute Node executable and no shell. It is a local parent
facility, not a general command runner or an MCP capability. Workspace grants
cannot contain or sit inside the running scripts directory, so delegated edits
cannot self-update code that an unattended restart would execute. To develop WebGPT,
use a separate source checkout and install reviewed updates while idle. It never starts a
browser, Codex, Git, cloudflared or arbitrary user-supplied commands.

The worker and its controller still bind exclusively to `127.0.0.1`. A tunnel may
forward only the MCP listener. Never route the controller, readiness, reconciliation
or shutdown interface to the Internet. Keep runtime, configuration, credentials,
results, recovery records and logs outside every granted workspace. This remains a
cooperative filesystem boundary, not an OS sandbox against a malicious local user.

## Lock recovery and shutdown

`worker.lock/owner.json` and `service.lock/owner.json` contain a host, PID and random
instance identity. A stale owner can be recovered only on the same host when a
zero-signal existence check reports that its PID is absent. The previous lock is
renamed to a unique `.lock.stale-*` directory, not deleted. A separate recovery
claim directory serializes reclaimers. Release verifies the instance identity.
A live/reused PID, denied/unknown ownership, another host, invalid/missing owner,
or an interrupted recovery claim requiring inspection is not grounds for theft.
There is no age/heartbeat timeout that can evict a live but slow process. On a
reboot, PID reuse may therefore require manual inspection rather than unattended
recovery. Keep the runtime on one local Windows machine, not a shared network drive.

Worker shutdown rejects new requests and rechecks already received requests after
body parsing. It wakes outstanding waits with `interrupted: true`, stops listening,
drains for up to five seconds, closes remaining HTTP connections, then releases
its own lock. It does not cancel tasks, acknowledge results or replay mutations.
The controller's authenticated `POST /shutdown` accepts only `{}`. The corresponding
local command is `node <absolute-client.mjs-path> shutdown` with the private config.

For a supervised worker, `service.mjs stop` is the preferred wrapper stop command:
it writes an instance-scoped request inside the private supervisor lock directory.
The launcher accepts only a regular single-link marker matching its instance ID,
observes it within its 250 ms polling interval, aborts pending backoff
and sends shutdown over its owned child's IPC channel. After ten seconds it may
force-stop that still-owned child, leaving crash evidence for subsequent recovery.
No PID from a foreign lock or HTTP port is killed. A foreign or malformed stop
marker is preserved for inspection; it cannot stop a replacement instance.
Windows SIGINT/SIGTERM semantics alone are not the graceful-stop contract.
WinSW v2.12.0 waits without a deadline when `stoparguments` is configured: its
`stoptimeout` setting applies only to the alternate process-tree shutdown path.
The example therefore does not promise a wrapper-enforced stop deadline. The
launcher's ten-second child deadline works only while the launcher remains
responsive. A hung supervisor, a failed stop command or OS/filesystem deadlock can
leave the Windows service in STOP_PENDING and requires explicit operator
inspection and termination of the verified owned processes. Test these failure
cases before installing the wrapper; an XML timeout does not establish recovery.

A responsive Worker shuts down when its launcher's IPC channel disconnects, including
during startup. This is not an automatic hang watchdog. If the child remains alive,
do not adopt or kill it by guessing. A subsequent worker's ownership check refuses
the duplicate. Inspect and stop the identified owner through its permitted local
lifecycle interface. See [recovery-integrity.md](recovery-integrity.md) for this
ownership contract and interrupted-result handling.

## Liveness, readiness and recovery diagnostics

| Check | Exposure | Meaning |
| --- | --- | --- |
| `GET /health` | MCP listener; unchanged public response | HTTP process responds, not storage/task readiness. |
| `GET /ready` / `client.mjs ready` | Authenticated controller only | 200 when checks pass, otherwise 503 and reason categories. CLI exits nonzero on failure. |
| `GET /reconcile` / `client.mjs reconcile` | Authenticated controller only | Read-only inventory including collected/cancelled tasks, recovery warnings and local artifact hash verification. |

Readiness verifies that state bytes still match the worker's last owned commit,
performs an isolated write/flush/rename/delete canary in the private runtime, and
checks active recovery journals, their original backups, and workspace identity/access. Issues distinguish
`STATE_INVALID`, `STORAGE_UNAVAILABLE`, `RECOVERY_REQUIRED`, `RESULT_RECOVERY_REQUIRED`, `WORKSPACE_UNAVAILABLE`
and `SHUTTING_DOWN`. Credentials, prompts and inputs are not included. Actual
storage-write failures are sticky until a successful real persist or a controlled
restart after repair; a successful canary alone must not hide a failed result save.

This is an advisory, point-in-time check, not a proof that every future write will
succeed. It does not measure tunnel reachability, browser login, model progress,
every individual file's write ACL, all retained artifacts, or physical power-loss
durability. `flush` on state/result files does not make all journal/project writes
transactional or guarantee directory metadata durability. Backup, prepared-journal
and project writes are flushed, and applied journals replace prepared records only
after a separate temporary record is flushed. See [backup-safety.md](backup-safety.md)
for interrupted-publication evidence and operational-config isolation. Inspect the journals
before resuming interrupted mutations. The existing per-task quarantine remains:
a bad task blocks its further edits/completed submission, not unrelated tasks.
Readiness has `automaticRestartRecommended: false`; do not turn every 503 into a
process restart. A watchdog timeout also does not prove which component failed.

Malformed/non-UTF-8 state, invalid structure, nonportable/duplicate IDs, duplicate
active tokens and unsafe pending-result paths stop startup without resetting the
file. Before the first state commit, the worker writes and flushes `state.initialized`.
Existing valid legacy state receives this marker on startup without changing the
task schema. A missing state file beside this marker, a temp state, result or recovery
directory is not an empty deployment. A crash between marker creation and the first
state commit requires inspection. Keys alone still permit a never-registered runtime
to start; a legacy state lost before migration with no remaining evidence cannot be
distinguished from that case. External state or marker edits while running block new mutations rather
than being silently overwritten. Preserve state, temp files, before-images, results
and lock archives. Never use deletion, empty JSON or automatic journal replay as a
repair method. Readiness/reconciliation do not authorize task recovery decisions.

## Failure classes and retry budgets

The optional launcher owns a single lifetime budget: at most three worker restarts
after 1, 5 and 15 seconds. Only unexpected exit 1, supported abnormal termination
signals, and Windows DWORD exit `4294967295` (observed with PowerShell
`Stop-Process`) are retry candidates. The latter is an exit-code policy, not proof
of who terminated the process. Other unknown Windows status codes still stop.
Clean exit 0 is not restarted. Worker exit 65 means
invalid state, 73 means ownership/port conflict, 74 means storage failure, and 78
means invalid configuration: all stop without automatic retry. Unknown nonzero
codes also stop. These codes are this launcher's contract, not a claim about
cloudflared's or WinSW's exit-code meanings.

The WinSW example deliberately uses `onfailure action="none"`. Do not add an outer
restart loop, scheduled task or SCM recovery action that resets the launcher's
budget. The last WinSW recovery action repeats, so a final restart action is not a
finite policy. Supervisor failure/exhaustion is an inspection point. Automatic
start at the next approved reboot is a separate operating decision.

Active parent `waitForTasks` calls retry only fetch transport errors/timeouts or an
explicit transient shutdown response. The default has three delays (250 ms, 1 s,
3 s, with bounded jitter), retains task scope and never resets the retry budget on
empty long-poll renewals. Each HTTP request also has a timeout. User abort, invalid
JSON, missing credentials, 4xx, data/config/storage failures and recovery notices
are not repaired by retry. `interrupted` returns control to the parent. The parent
must not wrap exhaustion in an unbounded replacement loop. POST registration,
collection/acknowledgment, cancellation and file changes are not automatically
replayed. Uncertain acknowledgments are resolved by reconciliation. An identical
terminal result retry remains supported by the existing worker contract.

| Failure | Scope of this change |
| --- | --- |
| Worker force exit | Proven-dead lock recovery and finite owned-child restarts; journals still decide edit safety. |
| Worker hang | Readiness/request timeout can reveal unresponsiveness; no autonomous kill/replay. Explicit service stop has an owned-child deadline. |
| Tunnel exit/network loss | Separate tunnel owner; no worker restart solely for tunnel failure. cloudflared reconnects internally; external exit policy must be separately verified and bounded. |
| Reboot before login | Possible only after separately authorized service account, startup mode, ACL and actual Windows reboot tests. Template is Manual by default. |
| State/journal corruption | Preserve evidence; invalid global state stops, affected journals quarantine tasks. No automatic repair. |
| Completion/callback interruption | Saved events/results remain collectable; compare hashes and retained chat before another submission. |
| Codex/browser closure | No parent launch, browser reopening, prompt resend or automatic task execution. Resume procedure below. |
| Sleep/power off | Local files/server unavailable; use an approved power policy or always-on host. A fixed DNS name cannot fix this. |

## Explicit paths, accounts, credentials and logs

### Current-user Task Scheduler deployment

For an existing private current-user installation, the optional
`deploy/windows/register-worker-task.ps1` registers an OS-owned launch with that
same interactive identity and `RunLevel Limited`. It neither creates an account
nor modifies ACLs, credentials, the tunnel or ChatGPT. Windows may require an
elevated **same-user** PowerShell to register it; `Access denied` must be resolved
through the authorized OS administration step, not another launch trick.
Registration does not start or stop anything and refuses an existing task name.

```powershell
& 'C:/path/to/installed/webgpt/deploy/windows/register-worker-task.ps1' `
  -TaskName 'WebGPTWorker' -NodePath 'C:/Program Files/nodejs/node.exe' `
  -ConfigPath 'C:/private/config.json' -DataPath 'C:/private/runtime' -AtLogon
```

Without `-AtLogon`, the task is manual-only. With it, it starts at this user's
logon, **not before login**, and is not guaranteed to survive logoff. A built-in
Administrator account is not made into a dedicated low-privilege identity by this
setting; inspect the actual token. The scheduler uses IgnoreNew, no execution time
limit, no battery stop, and **no scheduler restart policy**. Each explicit start or
new logon creates a new supervisor lifetime; do not repeatedly start it to conceal
an exhausted budget. The WinSW option remains appropriate for separately reviewed
boot-before-login requirements.

Before starting the registered task, freeze dispatch, verify idle and back up the
deployment as described below, then gracefully stop the existing identified
Worker and verify its exit. Only then run `Start-ScheduledTask -TaskName WebGPTWorker`.
Check the task principal/action/settings, actual process ancestry, both runtime
locks, listeners, `ready`, `reconcile`, and the existing HTTPS endpoint. A successful
registration or Task Scheduler's Running state is not readiness proof.

Stop using `service.mjs stop` with the explicit private environment, then verify
both locks and processes are gone. Do not use `Stop-ScheduledTask` as the normal
graceful stop. To disable future launches, disable the exact registered task;
this alone does not stop an already running process. Delete the task only after
verifying the reviewed action and stopped state. Do not remove runtime evidence.

The runner starts only its sibling supervisor via the explicit Node executable.
It records launcher/supervisor exit observations, plus supervisor and worker
stdout/stderr, in `dataDir/service-logs`. An exclusive OS file handle prevents
concurrent runner log rotation. It retains eight sessions; each reviewed supervisor
has at most four child launches, with lifecycle-only normal output. This is session
retention, not a general byte quota for arbitrary diagnostic output. Existing
symlink/hardlink log targets are refused. Keep all logs under private runtime ACLs.
After a supervisor has started, launcher event logging is best-effort: a log write
failure emits a fixed fallback diagnostic and does not stop supervision, release
the exclusive guard, or replace the supervisor's exit code. Startup log failure
before launch still prevents starting a child. If another launcher error occurs
after launch, the runner retains its guard and waits for its child before returning
failure; use the existing service stop protocol if the child needs to be stopped.
Forced termination of the runner itself cannot reliably write a final log; inspect
`Get-ScheduledTaskInfo` and available Windows Task Scheduler history as external
evidence. Do not infer an exit cause merely from a missing final record.

Supervisor JSON records contain UTC time, supervisor PID/parent PID/instance ID,
child PID and attempt, observed exit code/signal, stop reason and retry disposition.
They omit prompts, tokens and config contents. `worker.pid` is not maintained or
read by this launcher: use the instance-scoped locks plus process identity and
readiness. Preserve obsolete PID notes as historical evidence rather than treating
them as current status.

Validate the wrapper with disposable data first, including actual Windows
`Stop-Process`, explicit stop, config failure, duplicate launch, and log retention.
Then validate Codex full restart and a later Windows login separately. Do not
report app-lifetime independence or reboot recovery from direct-shell tests alone.

### Service identity and paths

`service.mjs` requires an absolute `WEBGPT_CONFIG` and an explicitly configured
absolute data directory (in that file or `WEBGPT_DATA_DIR`). It refuses to infer a
new service account's home directory. Paths to Node, scripts, working directory,
config and logs are explicit in `deploy/windows/worker.xml.example`. Do not overwrite
an existing configuration with the example or move active runtime data implicitly.

Prefer a dedicated non-administrator service identity with only the necessary
rights; verify the actual token, not the username. Grant the reviewed executable,
script and wrapper trees read/execute, not write. Grant runtime/log directories the
required modification rights, private configuration read, and only intended project
access. Keep tunnel credentials separate from worker data; the tunnel identity does
not need project/controller access. A parent collecting local results needs the
appropriate private read/controller access. Any account/ACL/logon-right change is a
separate approved operation, not performed by these scripts.

The example explicitly uses passwordless LocalService rather than WinSW's implicit
LocalSystem default. LocalService is a shared low-privilege identity, not per-service
isolation; a dedicated account or reviewed service-SID ACL may be more appropriate.
Existing current-user/SYSTEM-only ACLs will not automatically admit LocalService;
a safe failure is expected until an authorized decision and ACL validation occur.
Do not solve this with broad Users/Everyone write access or elevation. The v2.12
example uses `domain` + `user`; v3's `username` syntax must not be mixed into it.
No password, logon-right grant or installer is included.

The wrapper example rotates stdout/stderr at 10,240 KB with eight rolled files per
stream. Wrapper diagnostic logs/event logs and runtime evidence need separate
retention review. Do not rotate/delete recovery records or task results as ordinary
logs. Never log MCP secret URLs, authorization headers, controller/task tokens or
result contents. The worker/launcher startup messages contain event names, local
ports and failure codes only. No executable auto-download/update hook is included.

For a future fixed HTTPS endpoint, a Cloudflare named tunnel plus an owned hostname
is a conditional choice, not an installed feature here. Account, domain and plan
availability remain operator prerequisites. A remotely managed tunnel supports a
private `--token-file` on documented versions, avoiding the token value in process
arguments; do not confuse this token file with local-tunnel credentials JSON. Keep
cloudflared logs private, avoid debug request/header logging, and verify rotation
rather than assuming a single `--logfile` rotates. Leave controller forwarding off.

This change preserves the existing MCP secret path plus task-token boundary; it
adds no OAuth or Cloudflare Access login. ChatGPT's documented OAuth support is not
proof that an arbitrary Access login page or required service-token headers will
work. Verify the exact OAuth/resource-metadata/connector flow in a disposable
connection before changing production authentication. Do not call the secret path
an OAuth credential or assume it cannot leak through URL logs.

Credential rotation is a maintenance workflow, not automatic code here: inventory
active tasks/clients, save results, stop identified components, rotate only the
intended credential through an approved channel, update private clients/connector
configuration, then test success and rejection of the old credential. Do not rotate
all layers together. Do not roll back to a compromised secret. Revoking task access
uses existing explicit collection/cancellation; recreating a task is a new dispatch
decision, not automatic replay. Never put real credentials in these templates.

## Parent resume, transition and rollback

On parent resume, load the private ledger and run `ready` then `reconcile` before
redispatching. Restrict decisions to owned IDs. Reconciliation includes retained
hashes even after collection; `browserChecked: false` explicitly means no chat was
inspected. Match ID, grant, chat URL/tab identity, saved SHA and last collected/
verified disposition. The controller does not persist chat URLs; the ledger remains
the authority for that mapping. Inspect a still-running retained chat through the
existing authorized browser flow. Missing callbacks do not prove missing results.
Collect verified uncollected artifacts; do not acknowledge already collected ones.
Integrity/recovery failures need investigation. Never resend a prompt merely because
the worker/server restarted, and never interpret a verified hash as verified code.

Before changing an existing installation, record a private baseline: installed and
candidate commits, actual process executable/script paths, PID and creation time,
launch/restart owner, effective account token, listening addresses/ports, config/data
paths, and current ACLs. Inspect the existing ChatGPT connection's endpoint, seven
tool schemas and action-permission setting; a previous setup note may be stale.
Compare the full endpoint privately without printing its secret path. Treat a UI
permission such as allowing all actions as a separate setting from worker task
authorization: it does not expand the seven tools, but must not be assumed to prompt
before a write/delete. Use read grants for reviews and edit grants only for assigned
changes. Record observations, not credential values, in the maintenance report.

Identify each revision's supported lifecycle commands before stopping anything.
For example, `c87b752` supports `tasks` and `status`, but not `ready`, `reconcile`
or `shutdown`. Use its matching client, private ledger and local artifact verification
for the inventory. Do not start a candidate worker on live data merely to validate it:
startup can create locks, credentials or `state.initialized`. Likewise, `ready` and
`reconcile` run a storage canary; they are not filesystem-passive audit commands.
Use isolated fixtures for startup, migration and failure tests.

For an authorized code update, complete these steps in order:

1. Prepare a clean, pinned candidate outside the live installation and run repository
   tests and relevant platform probes with disposable ports/data. Preserve any local
   installation customizations for review. Keep worker, client and helpers together.
2. Freeze new dispatch, inventory owned running/uncollected work, retain chats/results
   and collect verified results. Confirm idle using `tasks`, not just `status`.
   Preserve and explicitly resolve any exceptions under [setup.md](setup.md).
3. Stop the identified supervisor/restart owner and worker through the lifecycle
   supported by the installed revision. A supervisor waiting in backoff is not stopped.
   Verify process exit and release of the worker's listeners before any code replacement.
   A shutdown acknowledgment alone is not proof of exit. Do not terminate by broad
   process name or a saved PID without rechecking its executable, creation time and owner.
   For a legacy Windows launch requiring forced termination, first establish idle,
   then preserve the stale lock and inspect state/journals; the new worker may reclaim
   only a proven-dead owner under its normal lock rules. Never delete a lock to proceed.
4. With the worker stopped, take a consistent private backup of its state, initialization
   marker if present, temporary files, results, recovery records, retained locks and
   recovery-claim directories, keys, configuration and parent ledger, plus the matching
   prior code/revision. A source-code backup or
   individual `.before.txt` files alone cannot restore the deployment. Keep backup
   destinations outside the tree being copied and outside workspace grants. Verify
   file inventory/hashes and ACLs on the actual backup files, including inherited and
   explicit rules; a private parent directory alone does not establish private children.
   Windows moves or copies that preserve security descriptors can retain old access.
   Check restorability in a separate private location without starting another worker
   against production paths. Live tunnel logs may continue changing; do not describe
   those logs as a stopped snapshot. Preserve all evidence if backup verification fails.
5. Replace only the stopped installation with the complete reviewed revision; verify
   files before restarting with the same intended identity, config, data and ports.
   For a code-only update, keep the healthy existing tunnel and ChatGPT connection.
   Do not bundle account/ACL, credential, service, DNS or authentication changes into
   the replacement. In particular, restarting a Quick Tunnel changes its origin.
6. Confirm the new process identity and listeners, then run supported `ready`, `reconcile`
   and `tasks` checks. Compare task/result/recovery evidence to the baseline before new
   dispatch. Verify the existing HTTPS endpoint and connection settings; refresh stale
   or changed tool schemas without recreating the connection or altering permissions.
   Complete the owned disposable ChatGPT probe in [setup.md](setup.md#4-verify-the-installed-path)
   before reporting the updated installation as verified. HTTP discovery alone is not E2E.

Account/service and endpoint changes have their own validation gates:

1. On Windows with the target Node build, verify force kill, concurrent starts,
   permission-denied/PID-reuse refusals, malformed state/partial journals, storage
   failure, in-flight shutdown and lock release. Linux tests are not these results.
2. Only after separate approval, choose the identity/ACL/start mode, verify the pinned
   WinSW binary and rendered XML, then test actual wrapper stop/start, hung-supervisor
   and failed-stop-command handling, bounded failure recovery, log rotation and
   boot-before-login. The supplied XML is not installed.
3. Independently approve fixed hostname/tunnel/authentication changes and test real
   ChatGPT tool discovery, task read/write, stale-SHA rejection, completion and parent
   collection. Record which tests remain NOT_RUN. Do not infer E2E success from HTTP.

Rollback is a reviewed code/config revision switch, not state reset. Freeze dispatch,
stop the identified launcher/worker, preserve current evidence including
`state.initialized` and the latest state, then restore the
matching prior worker/client/helper set and configuration. This change keeps the
JSON task shape, but the old worker has weaker readiness/lock behavior; validate
state and inspect journals, original backups and result candidates with the current
validators first. If evidence cannot be reconciled safely, leave the worker stopped;
starting old code is not a repair. Never overwrite a newer task state with a
backup simply to make the old code start. No automatic destructive rollback is
provided. Preserve old credentials only for non-compromise rollback when explicitly
approved. Record the revision and use its supported checks after rollback. If it has
`reconcile`, use it; otherwise compare that revision's `tasks`/`status`, private ledger
and verified local result/recovery artifacts manually. Record unavailable readiness
or reconciliation checks as unsupported, not passed. Keep dispatch frozen until
the evidence agrees and the restored connection has been verified.

## Official references

Reviewed 2026-09-21; docs are evidence, not successful Windows execution.
- [Node 24 signal behavior and zero-signal process probes](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)
- [Node 24 HTTP close/drain behavior](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback)
- [WinSW v2.12.0 XML configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)
- [WinSW v2.12.0 log rotation](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md)
- [Microsoft LocalService identity](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account)
- [Microsoft file permissions when copying or moving](https://learn.microsoft.com/en-us/troubleshoot/windows-client/windows-security/permissions-on-copying-moving-files)
- [Cloudflare Quick Tunnel limits and intended use](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [cloudflared run parameters, token-file and logging](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
- [Cloudflare Windows service considerations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/)
- [ChatGPT developer-mode authentication](https://developers.openai.com/api/docs/guides/developer-mode)
