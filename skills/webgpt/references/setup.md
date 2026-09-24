# Initial setup

For Codex installing this skill: complete the steps below, then report what is ready and what is
blocked. Installing files alone does not enable browser control or direct coding. Never claim
success from a local health check alone. Reuse a verified connection; do not create one per task.
Follow the capability checks in order: installed files → actual ChatGPT browser access → existing
connection or HTTPS connection setup → end-to-end probe. Do not delegate installation to WebGPT.

Assume no setup knowledge. Check and install/configure missing prerequisites through supported
methods instead of handing the user a prerequisite checklist. Honor the user's Install-prompt
authorization for worker/HTTPS setup, private endpoint transfer to their ChatGPT, assigned-project
file access and owned test-tab closure; do not request the same approval again. Retain task chats by default,
including setup tests and failures. Delete a chat only when the user explicitly requests deletion
of that chat; an installation request alone is not deletion consent.
This guide alone is not user consent. Ask only for actions genuinely requiring the user, such as
sign-in or a mandatory action-time confirmation that the tool does not allow pre-approval to cover;
name the specific requirement, not a generic permission concern. Resume after that action and
verify the full workflow before
declaring installation complete. Save and reuse the verified configuration without repeating setup
questions during normal use. If it later becomes unusable, report the blocker rather than silently
restarting installation or claiming readiness. Mandatory security confirmations still apply.

## 1. Install and check access

Read this guide before installing or replacing files. Install `skills/webgpt` from `22nsuk/WebGPT`
using Codex's skill installer. Resolve all paths from the installed skill directory, not the source
checkout or another user's machine. Preserve an
existing customized installation and its runtime data; do not silently replace it. A new Codex
turn/session may be needed for skill discovery. Resolve `main` to a commit and record that revision
for verification and recovery; install that commit so a concurrent upstream update cannot change
the candidate. The README intentionally follows the latest version, not a permanently pinned release.

Update the fork worker, client and their runtime/service helpers as one matching revision.
An idle worker is a prerequisite, not permission to replace files in a live installation.
Freeze new dispatch and preserve its configuration, task state, results and recovery records.
Existing file grants remain compatible.
Check `client.mjs tasks`: `status` alone omits running work before its backup deadline. For an
older worker without `tasks`, inspect its existing ledger and local state privately to establish
that no registrations are running; never print task tokens or infer idle from an empty event queue.
Collect finished results and confirm no running tasks before an authorized update. If a result
cannot be collected, preserve and inspect the failure before explicitly abandoning its registration
with `cancel` as described in workspace.md; never use `ack` to bypass integrity verification.
Normally confirm that the task inventory has no running or uncollected entries before updating.
Then stop the identified worker and any supervisor or restart mechanism through their existing
supported lifecycle, and verify that they have exited before replacing code. A supervisor in
backoff is still live. Legacy revisions without `shutdown` need their existing owned launcher's
stop procedure; a newer client cannot add that command to an old worker. Preserve any stale lock
and inspect its owner after forced termination; do not delete it to make startup succeed.
Take a consistent private backup after the worker has stopped, verify the backup's contents and
actual file ACLs, and stage the complete reviewed revision outside the running installation.
Start the replacement with the same intended identity, explicit configuration, data and ports.
Keep a healthy tunnel running during a code-only update; preserve its origin, secret path and
existing ChatGPT connection. Follow the detailed
[transition and rollback procedure](operations-windows.md#parent-resume-transition-and-rollback),
including checks supported by each revision and the separate gates for account or tunnel changes.
An older worker may report successful terminal cancellation without retiring the registration.
For that specific case, preserve its private state, results, recovery records and collection error;
verify there are no running tasks, stop the identified owned worker and update the matching worker
and client together while preserving the uncollected terminal records. After restart, use the new
`cancel` behavior for the explicitly abandoned registrations and confirm the inventory is empty
before dispatching new work. Do not acknowledge corrupt results or edit state by hand to force
the old inventory to clear. Verify the existing connection's endpoint, permission setting and
tool schemas afterward; refresh schemas if they changed or are stale. `list_files` must expose
optional `cursor` and `limit` with the same seven tools. Do not recreate a compatible connection
or change its permissions as an incidental update step.
Task-scoped waits require the updated worker; a protocol error is not permission to restart active
work. This fork rejects terminal/open grants and live upstream terminal state. Retire those sessions
with their matching worker before choosing a separate file-worker setup; never reinterpret or
overwrite active grants. See [fork-policy.md](fork-policy.md) for the integration boundary.

First discover this session's browser-control tools, including deferred tools, and enumerate the
user's existing browsers/tabs through their documented APIs. Use the user's already-signed-in
browser and open an owned task tab there at `https://chatgpt.com`; do not launch an isolated browser,
create a fresh profile or request another login just because a Playwright executable is available.
Read its actual UI. Verify sign-in and the requested Extra High or Pro mode (Extra High when
unspecified). A browser executable/version, an HTTP response or opening a URL with the OS is not
proof that Codex can control the page. Preserve working browser/tool configuration when installing
this skill. If browser control is missing, discover and set up a supported
browser connector using the host's plugin/tool manager, then recheck. Never copy cookies or use
private browser APIs. If sign-in or an extension approval is required, open only that actionable
screen and ask for that user-only action; resume when it is done.

Once browser access works, inspect ChatGPT's existing connections and any saved WebGPT setup note
or local tunnel profiles. Reuse a compatible connection and its settings after verifying its tools
and endpoint; a connection name alone is not proof. Do not request new tunnels, keys or account
permissions merely because the skill was freshly installed. Do not ask the user to carry out
navigation, configuration or commands that your available tools can perform.
Inspect the connection's settings, not just its name/tools in the composer. When replacing a
legacy Tunnel connection with HTTPS, verify its configured type and full URL against the live
endpoint before the probe; a listed tool can still point to a terminated old tunnel.

Text-only delegation can run without a workspace connection, with 15-minute completion checks.
For **local file access or event-driven completion**, continue below. An existing authorized connector
must provide the required file access (if any) and saved completion events.

## 2. Start the bundled worker

Use Node.js 22+. With `<skill>` replaced by the installed directory, run:

```text
node <skill>/scripts/worker.mjs
```

Defaults: private data in `~/.local/share/webgpt`, MCP at `http://127.0.0.1:43137/mcp`, parent
controller at `http://127.0.0.1:43139`. `~` here means the current user's home on their OS.
Both the worker and `scripts/client.mjs` read the same optional
`~/.config/webgpt/config.json`:

```json
{
  "dataDir": "/absolute/private/webgpt-data",
  "mcpPort": 43137,
  "controlPort": 43139,
  "publicMcp": true
}
```

Use real OS-appropriate absolute paths, not these placeholders. Only create this configuration
when overriding defaults; set `publicMcp:true` before forwarding MCP over public HTTPS.
`WEBGPT_CONFIG` selects another configuration file; `WEBGPT_DATA_DIR`
overrides only the data directory. Give the worker and client the same configuration/environment.
Keep data/configuration outside projects and installed skill files, private to the current user.

Configuration and controller CLI JSON payload files must be UTF-8. One leading
UTF-8 BOM is accepted; Korean text, emoji, CRLF and BOM characters inside JSON
strings are preserved. Invalid UTF-8 and malformed JSON fail without substituting
replacement characters or echoing file contents. UTF-16 and legacy code-page files
are not automatically detected or transcoded. Save a reviewed UTF-8 copy instead
of rewriting a live configuration. Windows PowerShell 5.1's `-Encoding UTF8` writes
a BOM and is supported; its default `>` output is UTF-16LE and is not.

The configuration pathname and effective `dataDir` must also be well-formed Unicode
absolute paths; escaped unpaired surrogates are rejected before runtime creation.
A literal U+FFFD character in a valid UTF-8 path remains valid. An explicitly selected
missing config is an error. Only an absent implicit config uses the existing defaults;
permission/I/O failures do not masquerade as an unconfigured installation. Environment
overrides retain their precedence but do not make invalid config bytes acceptable.

Each configuration load decodes once. The service's explicit-directory check and its
selected settings use that same read, rather than reopening the file. This is not a
cross-process snapshot: a worker and a later stop request load configuration separately.
Do not edit configuration while its service is running; keep the existing stopped-update
procedure. No file, charset, service setting or saved runtime is migrated automatically.

The worker rejects a project root containing or located inside its private data directory,
including recovery subdirectories, even for read-only tasks.
Existing overlapping grants remain cancellable but cannot use file tools; choose a separate, safe
project root rather than moving active runtime data or weakening the check.
Do not publish `controller.key`, task tokens, results, recovery copies or tunnel credentials.
On POSIX, set the owned WebGPT data directory to mode `0700` and verify it before starting the worker;
recursive directory creation does not restrict an already-existing directory's permissions.
On Windows, verify directory ACLs explicitly; POSIX file modes alone do not establish privacy.

Check that both ports are free, or belong to the exact existing WebGPT service, before starting.
Never kill another port owner. Choose unused ports in the shared configuration if needed. Confirm
the worker's `listening` output, GET its MCP `/health`, and run:

```text
node <skill>/scripts/client.mjs status
node <skill>/scripts/client.mjs ready
```

`listening` and `/health` establish liveness only. Require authenticated readiness and inspect
any reported storage, state, journal or workspace issues before the end-to-end probe.

An empty or HTTP-incompatible `controller.key` stops CLI startup with `CONFIG_INVALID` before
either listener opens. This can follow an interrupted initial key write or a manual edit that adds
a trailing newline/space. The worker preserves the file and existing task state; it does not trim
or rotate credentials automatically. Preserve the failed file privately, verify the owned worker
is stopped and restore the original valid key from a trusted private copy before retrying. If no
valid key exists, explicitly reinitialize the controller credential for that owned runtime after
preserving its state, then verify authenticated `status` again; do not delete task/result/recovery
data or publish the key to resolve the error. Startup validation checks HTTP compatibility, not
the strength or trustworthiness of a manually supplied key.

Keep the worker running using an owned persistent terminal or the OS's existing service manager;
record how to start/check it again. Use the OS service manager for operation after Codex exits;
a child terminal process is not evidence that the worker survives CLI shutdown.
Reuse the same data directory so tasks survive restarts. Do not
start two workers against one data directory or replace scripts while tasks are active.
The worker enforces this with `worker.lock/owner.json`. A confirmed dead owner on the same host
is automatically archived before lock recovery. Live/reused PIDs, uncertain owners and interrupted
recovery guards stop startup for inspection. Never delete an unverified lock or stop another owner.
See [operations-windows.md](operations-windows.md) for the optional bounded service launcher,
Windows deployment prerequisites, graceful stop and parent reconciliation.

Update the complete `scripts/` directory from the same reviewed revision, including
`worker.mjs`, `client.mjs`, `service.mjs`, `installation.mjs`, `protocol.mjs`,
`runtime.mjs`, `results.mjs` and all other shipped helpers, including the Windows
PowerShell helpers. This is not a minimal file list: do not copy only selected modules.
Both `worker.mjs` and `service.mjs` import `installation.mjs` unconditionally; omitting
it causes `ERR_MODULE_NOT_FOUND` before startup. Follow the stopped-installation
[update procedure](operations-windows.md#parent-resume-transition-and-rollback)
and verify the complete candidate file inventory before restarting.
Preserve and reconcile interrupted result candidates as described in
[recovery-integrity.md](recovery-integrity.md).
In a local MCP probe, confirm server version `1.4.1-fork.4`, protocol negotiation and an empty
`ping` result. Missing or unsupported protocol fields are not evidence of browser readiness.
Refresh the connection after updating the identified idle service, and still run the real
browser/connector probe below; no public connection or browser test is implied by local tests.

## 3. Connect to ChatGPT without Platform credentials

Reuse the signed-in ChatGPT account and compatible connection. New setup uses an HTTPS endpoint,
not OpenAI Secure MCP Tunnel: do not request Platform login, organization roles, API keys or tunnel
credentials. A working existing transport can remain unless the user requests its replacement.

1. Enable `publicMcp:true` in the shared configuration and restart only the owned idle worker.
   It creates private `mcp-path.key` (256-bit random hex); the only MCP route becomes
   `/mcp/<that-key>`. Check that `/mcp` and a wrong-key route return 404, a valid-route initialize
   succeeds, and tool calls with an invalid task token fail before making the endpoint reachable.
   The controller remains loopback-only and must never be forwarded.
2. Reuse an authorized HTTPS forwarding service if available. Otherwise install `cloudflared`
   from its official distribution and use a [Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/):

   ```text
   cloudflared tunnel --url http://127.0.0.1:43137
   ```

   Substitute the configured MCP port. This needs no Cloudflare account or OpenAI Platform login.
   Keep the owned process running and record its PID/service and emitted HTTPS origin. Do not
   overwrite another cloudflared configuration or stop another tunnel. If a default config
   interferes, use an isolated supported configuration rather than renaming the user's files.
   This forwards requests through Cloudflare, which terminates HTTPS; it is not a private-network
   tunnel. Never expose the controller, a file server or the project directory.
3. Form the connection URL from that origin plus `/mcp/<mcp-path.key>`. Treat the complete URL as
   a credential: read it privately into the connection form, never publish it or put it in task
   prompts, screenshots or ordinary logs. Do not navigate to it in a browser. The route key gates
   MCP discovery; independent task tokens still gate every file operation and completion.
   Verify public initialize/tools discovery and rejected wrong-key requests without printing keys.
4. In ChatGPT's Plugins settings, update **WebGPT Worker** to Connection: URL and the complete
   endpoint. Choose no OAuth authentication: the URL capability plus task tokens are the worker's
   authentication, not an unrestricted endpoint. If the UI cannot change connection type/URL,
   create a replacement and verify it before removing the exact obsolete registration. Preserve
   unrelated plugins. Reuse existing sign-in/developer-mode access; ask only for actual missing
   user-only approvals. Verify all seven tools in [workspace.md](workspace.md) and their action
   permissions. Use read-only task grants for reviews.

Quick Tunnels are development services without an uptime guarantee; their origin changes when
recreated. Keep a live tunnel across tasks. On restart, compare its actual origin and update the
existing ChatGPT connection (or replace it only if the UI requires), then recheck before dispatch.
Do not promise a permanent URL or unattended recovery. The worker uses JSON HTTP responses,
not SSE, which Quick Tunnels do not support. For stable hosting, reuse a user-authorized stable
HTTPS endpoint; do not silently require a new paid service/account. If the URL leaks, stop the owned
tunnel, rotate the path key while the worker is stopped, and update the connection.

No public plugin publication, Git integration, model API calls or API-model substitution is needed.
If connection setup is blocked, report the exact limitation and available text-only mode;
do not claim direct editing works or apply WebGPT's patches as a substitute.

## 4. Verify the installed path

Run `node --test --test-reporter=tap` from the installed skill directory (no shell glob needed).
Before controller registration, run `node <skill>/scripts/client.mjs dispatch preflight` in ordinary
Node. Keep ledger/lock/controller work in Node and browser actions in documented browser tools.
Initialize the actual browser tool before creating a task or entering a prompt. If initialization
fails, record the tool, time, stage and actual error; this alone is not evidence of a missing worker,
failed ChatGPT login or failed project grant. Check current readiness and the most recent verified
installation record rather than carrying an old handoff's connection diagnosis forward.

A browser tool's current working directory and its accessibility to project files are separate
questions. An UNC path is not by itself evidence of unsupported browser initialization. A complete
app restart resolved one observed Windows/UNC initialization failure; its precise original cause
was not established. Verify initialization in the actual affected task after restarting. A generic
MCP server's `cwd` setting does not automatically configure an app-managed browser server, and an
app-managed configuration may be regenerated on launch; verify effective state before attributing
recovery to that setting. Do not add path aliases or relax sandbox/file checks as a presumed repair.

Then follow [workspace.md](workspace.md) to register one edit task for an **owned temporary project**.
Record its task ID and owned chat/tab IDs in the private setup note as they are created.
In a real chat using the requested mode (Extra High or Pro), give WebGPT a natural, outcome-oriented
probe: exercise direct file creation/editing/deletion, revision-safe writes and terminal completion
reporting on an owned disposable file, and return receipts, evidence and limitations. State what the
probe must prove rather than prescribing the tool order; let WebGPT choose the exact sequence within
the temporary project grant. The parent verifies the final on-disk state, recovery copies, saved
result SHA, callback receipt and empty backup deadline, then uses `client.mjs collect --resume <task-id>`
to verify the saved bytes and acknowledge the result. Retain that task chat under SKILL.md. Record its URL and retained disposition. Close its task-owned tabs
and verify their absence per SKILL.md; preserve unrelated tabs. Clean only the owned temporary
probe files after recording evidence; this does not authorize deleting the chat.

Keep the following checkpoints in the **same original private setup record**, with each stage's
PASS/FAIL/NOT_RUN status and a reference to its private evidence: browser initialization; actual
mode/connector and sent message; exact relevant tool calls; on-disk changes/recovery originals;
saved-result integrity; collection/token retirement; retained-chat disposition and tab cleanup.
After interruption, run `ready` and the hash-verifying CLI `reconcile`, match the original task,
and resume only unfinished stages. Raw `request('reconcile')` does not add local result integrity.
An already collected result can be reverified with `collect --resume`; do not re-register it or
send another probe to repeat cleanup. Stop for missing/tampered artifacts or recovery warnings.
Neither a saved result nor `collected:true` proves browser E2E or token rejection by itself.

For menus/forms, wait for the expected visible control, expanded state or URL using the browser
tool's documented observation capability. A click response containing the old view is not proof
of failure; take one targeted observation before a justified retry. Do not replace this with fixed
sleeps or repeated clicks. Tool panels may contain cumulative history: open the latest list once
and locate the exact relevant invocation by identity/name/arguments, then its actual result. Text
quoting an expected revision conflict in a report is not a tool failure. Do not treat repeated
views of the same invocation as new calls. See [dispatch.md](dispatch.md) for bounded UI evidence.

If the probe fails, retain its chat and save the exact error shown in the tool-call UI and correlate
that error with any partial file-operation or callback receipts. A model summary alone does not
confirm a platform denial or broken feature. Record installation status separately from operation
verification. Security refusals remain non-bypassable; report them exactly and do not infer or claim
a prior platform cause without direct evidence. If its terminal callback cannot arrive, preserve
the finished output and inspect the retained chat and controller before a narrow completion retry.
If the probe is abandoned, cancel its registration after saving partial evidence so backup checks
stop. A missing callback alone does not authorize replaying edits or creating replacement work.
For a tool-level `blocked by policy`, distinguish rejection before process creation from an OS or
worker error. Record only the known policy reason; do not label it Auto-review unless that component
is identified. Existing user authorization does not change a tool's enforcement policy. Preserve
the pending stage and use an exposed official approval path when available, without retrying through
another shell/encoding or requesting broader access as a guessed fix. User-only commands should be
provided in a copyable code block with the required invocation syntax and no secrets.
Retain the finished probe chat and close its task tabs before pausing for account setup; keep only
the actionable sign-in/approval tab open among setup-owned tabs. Repair the connection before
registering another probe.

Record a compact, private setup note alongside runtime data: installed path/revision, configuration
path, worker/tunnel startup method, connection name, browser/mode and PASS/FAIL/NOT_RUN evidence.
Do not store credentials in this note. On later turns, reuse it and check readiness; no repeated
account setup. Report text delegation, direct editing, callbacks, chat retention/deletion disposition
and tab cleanup separately;
do not turn partial success into an installation PASS.
If a user-only action interrupts setup, save the completed steps and exact next action in this note
before pausing. After the user responds, continue the same installation rather than starting over.

Historical upstream acceptance was reported on macOS with Node.js 22 and 26; that is not
validation of this fork's current integration. Run the local suite and the browser probe above on
the actual installation. Report OS-specific, connector and browser checks as NOT_RUN until they
have actually run; passing local HTTP tests alone does not establish end-to-end readiness.
