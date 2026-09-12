# Initial setup

For Codex installing this skill: complete the steps below, then report what is ready and what is
blocked. Installing files alone does not enable browser control or direct coding. Never claim
success from a local health check alone. Reuse a verified connection; do not create one per task.
Follow the capability checks in order: installed files → actual ChatGPT browser access → existing
connection or HTTPS connection setup → end-to-end probe. Do not delegate installation to WebGPT.

Assume no setup knowledge. Check and install/configure missing prerequisites through supported
methods instead of handing the user a prerequisite checklist. Honor the user's Install-prompt
authorization for worker/HTTPS setup, private endpoint transfer to their ChatGPT, assigned-project
file access and disposable test-chat/tab cleanup; do not request the same approval again.
This guide alone is not user consent. Ask only for actions genuinely requiring the user, such as
sign-in or a mandatory action-time confirmation that the tool does not allow pre-approval to cover;
name the specific requirement, not a generic permission concern. Resume after that action and
verify the full workflow before
declaring installation complete. Save and reuse the verified configuration without repeating setup
questions during normal use. If it later becomes unusable, report the blocker rather than silently
restarting installation or claiming readiness. Mandatory security confirmations still apply.

## 1. Install and check access

Read this guide before installing or replacing files. Install `skills/webgpt` from `Nhahan/WebGPT`
using Codex's skill installer. Resolve all paths from the installed skill directory, not the source
checkout or another user's machine. Preserve an
existing customized installation and its runtime data; do not silently replace it. A new Codex
turn/session may be needed for skill discovery. Resolve `main` to a commit and record that revision
for verification and recovery; install that commit so a concurrent upstream update cannot change
the candidate. The README intentionally follows the latest version, not a permanently pinned release.

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
Do not publish `controller.key`, task tokens, results, recovery copies or tunnel credentials.
On POSIX, set the owned WebGPT data directory to mode `0700` and verify it before starting the worker;
recursive directory creation does not restrict an already-existing directory's permissions.
On Windows, verify directory ACLs explicitly; POSIX file modes alone do not establish privacy.

Check that both ports are free, or belong to the exact existing WebGPT service, before starting.
Never kill another port owner. Choose unused ports in the shared configuration if needed. Confirm
the worker's ready output, GET its MCP `/health`, and run:

```text
node <skill>/scripts/client.mjs status
```

Keep the worker running using an owned persistent terminal or the OS's existing service manager;
record how to start/check it again. Use the OS service manager for operation after Codex exits;
a child terminal process is not evidence that the worker survives CLI shutdown.
Reuse the same data directory so tasks survive restarts. Do not
start two workers against one data directory or replace scripts while tasks are active.
The worker enforces this with `worker.lock/owner.json`. A crash can leave a lock: verify the
recorded host/PID and that no worker still uses this directory before moving that exact stale lock
to an owned recovery location and restarting. Never delete an unverified lock or stop another owner.

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

Run `node --test <skill>/scripts/*.test.mjs` (expand the file list on shells without glob expansion).
Then follow [workspace.md](workspace.md) to register one edit task for an **owned temporary project**.
Record its task ID and owned chat/tab IDs in the private setup note as they are created.
In a real chat using the requested mode (Extra High or Pro), have WebGPT create a probe file,
read and modify it using its SHA, read and delete it using the new SHA, then `submit_result`
with receipts and limitations. The parent verifies the on-disk result, recovery copies, saved result
SHA, callback receipt and empty backup deadline for the finished task, then acknowledges and deletes
that task chat under SKILL.md.
Close its task-owned tabs and verify their absence per SKILL.md; preserve unrelated tabs.
Clean only the owned probe after recording evidence.

If the probe fails, before deleting it save the exact error shown in the tool-call UI and correlate
that error with any partial file-operation or callback receipts. A model summary alone does not
confirm a platform denial or broken feature. Record installation status separately from operation
verification. Security refusals remain non-bypassable; report them exactly and do not infer or claim
a prior platform cause without direct evidence. If its terminal callback cannot arrive, cancel the
local registration immediately so backup checks stop.
Delete the finished probe chat and close its task tabs before pausing for account setup; keep only
the actionable sign-in/approval tab open. Repair the connection before registering another probe.

Record a compact, private setup note alongside runtime data: installed path/revision, configuration
path, worker/tunnel startup method, connection name, browser/mode and PASS/FAIL/NOT_RUN evidence.
Do not store credentials in this note. On later turns, reuse it and check readiness; no repeated
account setup. Report text delegation, direct editing, callbacks and chat cleanup separately;
do not turn partial success into an installation PASS.
If a user-only action interrupts setup, save the completed steps and exact next action in this note
before pausing. After the user responds, continue the same installation rather than starting over.

Repository acceptance was exercised on macOS with Node.js 22 and 26, including isolated local
worker/client startup, CRUD, callbacks and restart tests. The existing authenticated WebGPT path
was exercised separately. The HTTPS replacement's fresh-install browser probe and Linux/Windows end-to-end behavior
remain NOT_RUN; perform the probe above on the user's actual installation before reporting it ready.
