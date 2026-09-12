# Initial setup

For Codex installing this skill: complete the steps below, then report what is ready and what is
blocked. Installing files alone does not enable browser control or direct coding. Never claim
success from a local health check alone. Reuse a verified connection; do not create one per task.

Assume no setup knowledge. Check and install/configure missing prerequisites through supported
methods instead of handing the user a prerequisite checklist. During installation, request only
user-only actions such as sign-in, local credential entry and necessary approvals, with a clear
next step; resume setup after each action. Resolve them and verify the full workflow before
declaring installation complete. Save and reuse the verified configuration without repeating setup
questions during normal use. If it later becomes unusable, report the blocker rather than silently
restarting installation or claiming readiness. Mandatory security confirmations still apply.

## 1. Install and check access

Install `skills/webgpt` from `Nhahan/WebGPT` using Codex's skill installer. Resolve all paths from
the installed skill directory, not the source checkout or another user's machine. Preserve an
existing customized installation and its runtime data; do not silently replace it. A new Codex
turn/session may be needed for skill discovery. Resolve `main` to a commit and record that revision
for verification and recovery; install that commit so a concurrent upstream update cannot change
the candidate. The README intentionally follows the latest version, not a permanently pinned release.

Check documented browser-control tools, a signed-in ChatGPT session, and access to the requested
Extra High or Pro mode. Set up missing supported tools; guide the user through any required sign-in
or account approvals, then recheck and continue. Report a blocker only when no supported setup path
is available. Never copy cookies or use private browser APIs.

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
  "controlPort": 43139
}
```

Use real OS-appropriate absolute paths, not these placeholders. Only create this configuration
when overriding defaults. `WEBGPT_CONFIG` selects another configuration file; `WEBGPT_DATA_DIR`
overrides only the data directory. Give the worker and client the same configuration/environment.
Keep data/configuration outside projects and installed skill files, private to the current user.
Do not publish `controller.key`, task tokens, results, recovery copies or tunnel credentials.
On Windows, verify directory ACLs explicitly; POSIX file modes alone do not establish privacy.

Check that both ports are free, or belong to the exact existing WebGPT service, before starting.
Never kill another port owner. Choose unused ports in the shared configuration if needed. Confirm
the worker's ready output, GET its MCP `/health`, and run:

```text
node <skill>/scripts/client.mjs status
```

Keep the worker running using an owned persistent terminal or the OS's existing service manager;
record how to start/check it again. Reuse the same data directory so tasks survive restarts. Do not
start two workers against one data directory or replace scripts while tasks are active.
The worker enforces this with `worker.lock/owner.json`. A crash can leave a lock: verify the
recorded host/PID and that no worker still uses this directory before moving that exact stale lock
to an owned recovery location and restarting. Never delete an unverified lock or stop another owner.

## 3. Connect privately to ChatGPT

Use OpenAI's [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
This requires ChatGPT developer-mode access and an eligible Platform organization/workspace with
tunnel permissions. These capabilities are account-dependent; the skill cannot grant them.

1. Install the platform's `tunnel-client` for this OS and read `tunnel-client help quickstart`.
2. Create/reuse a tunnel through the official Tunnels settings linked in that guide. Its runtime
   key needs Tunnels Read + Use; creating a tunnel needs Manage. Let the user provide secrets through
   a local secret store/environment, never a chat, committed file or printed command output.
3. With the real tunnel ID and chosen MCP port, create a private profile:

   ```text
   tunnel-client init --sample sample_mcp_remote_no_auth --profile webgpt --tunnel-id tunnel_... --mcp-server-url http://127.0.0.1:43137/mcp --health-listen-addr 127.0.0.1:43138
   tunnel-client doctor --profile webgpt --explain
   tunnel-client run --profile webgpt
   ```

   Use an unused profile/health port; do not overwrite an existing profile. Supply the runtime key
   locally as `CONTROL_PLANE_API_KEY` or a supported secret reference. The no-auth sample describes
   the **loopback MCP backend**, not a public unauthenticated server: the tunnel authenticates access.
   Never tunnel the controller. For persistent operation, use the client's documented managed
   runtime or an owned OS service; record the exact profile and startup method. Do not stop healthy
   shared services after each chat.
4. While worker and tunnel are ready, open ChatGPT's Plugins page and add **WebGPT Worker** using
   Connection: Tunnel and that tunnel ID. Honor account approval gates. Verify that the selected
   chat can invoke the seven tools listed in [workspace.md](workspace.md). If write actions are
   blocked, check this connection's action permissions, not global defaults. Enable all project
   actions only when authorized by the user; use read-only task grants for reviews.

No public app publication, Git integration, model API calls or API-model substitution is needed.
If private connection setup is blocked, report the missing permission and the available text-only
mode; do not claim direct editing works or apply WebGPT's patches as a substitute.

## 4. Verify the installed path

Run `node --test <skill>/scripts/*.test.mjs` (expand the file list on shells without glob expansion).
Then follow [workspace.md](workspace.md) to register one edit task for an **owned temporary project**.
In a real chat using the requested mode (Extra High or Pro), have WebGPT create a probe file,
read and modify it using its SHA, read and delete it using the new SHA, then `submit_result`
with receipts and limitations. The parent verifies the on-disk result, recovery copies, saved result
SHA, callback receipt and empty backup deadline for the finished task, then acknowledges and deletes
that task chat under SKILL.md.
Close its task-owned tabs and verify their absence per SKILL.md; preserve unrelated tabs.
Clean only the owned probe after recording evidence.

Record a compact, private setup note alongside runtime data: installed path/revision, configuration
path, worker/tunnel startup method, connection name, browser/mode and PASS/FAIL/NOT_RUN evidence.
Do not store credentials in this note. On later turns, reuse it and check readiness; no repeated
account setup. Report text delegation, direct editing, callbacks and chat cleanup separately;
do not turn partial success into an installation PASS.

Repository acceptance was exercised on macOS with Node.js 22 and 26, including isolated local
worker/client startup, CRUD, callbacks and restart tests. The existing authenticated WebGPT path
was exercised separately. Fresh-account tunnel provisioning, Linux and Windows end-to-end behavior
remain NOT_RUN; perform the probe above on the user's actual installation before reporting it ready.
