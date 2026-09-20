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
after 1, 5 and 15 seconds. Only unexpected exit 1 or supported abnormal termination
signals are retry candidates. Clean exit 0 is not restarted. Worker exit 65 means
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

Transition in separate gates:
1. Freeze new dispatch, inventory running/uncollected tasks and ownership, retain
   chats/results and take a consistent private backup. Identify the existing worker
   and tunnel before stopping either; do not terminate by broad process name.
2. Review/apply the code change to a clean revision; run repository tests and the new
   operations/service tests in isolation. Keep client, worker and helpers together.
   Verify configuration paths against the existing runtime; use disposable ports and
   data for failure injection, never live project evidence.
3. On Windows with the target Node build, verify force kill, concurrent starts,
   permission-denied/PID-reuse refusals, malformed state/partial journals, storage
   failure, in-flight shutdown and lock release. Linux tests are not these results.
4. Only after separate approval, choose the identity/ACL/start mode, verify the pinned
   WinSW binary and rendered XML, then test actual wrapper stop/start, hung-supervisor
   and failed-stop-command handling, bounded failure recovery, log rotation and
   boot-before-login. The supplied XML is not installed.
5. Independently approve fixed hostname/tunnel/authentication changes and test real
   ChatGPT tool discovery, task read/write, stale-SHA rejection, completion and parent
   collection. Record which tests remain NOT_RUN. Do not infer E2E success from HTTP.

Rollback is a reviewed code/config revision switch, not state reset. Freeze dispatch,
stop the identified launcher/worker, preserve current evidence including
`state.initialized` and the latest state, then restore the
matching prior worker/client/helper set and configuration. This change keeps the
JSON task shape, but the old worker has weaker readiness/lock behavior; validate
state with the current validator first. Never overwrite a newer task state with a
backup simply to make the old code start. No automatic destructive rollback is
provided. Preserve old credentials only for non-compromise rollback when explicitly
approved. Record the revision and re-run reconciliation after the rollback.

## Official references

Reviewed 2026-09-20; docs are evidence, not successful Windows execution.
- [Node 24 signal behavior and zero-signal process probes](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)
- [Node 24 HTTP close/drain behavior](https://nodejs.org/docs/latest-v24.x/api/http.html#serverclosecallback)
- [WinSW v2.12.0 XML configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)
- [WinSW v2.12.0 log rotation](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md)
- [Microsoft LocalService identity](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account)
- [cloudflared run parameters, token-file and logging](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)
- [Cloudflare Windows service considerations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/windows/)
- [ChatGPT developer-mode authentication](https://developers.openai.com/api/docs/guides/developer-mode)
