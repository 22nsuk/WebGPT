# Manual installation — file-scoped WebGPT

**English** · [한국어](install-manual.ko.md) · [Agent procedure](setup.md)

This guide installs `22nsuk/WebGPT`, not the upstream terminal worker. A human can
perform these steps; a local agent should also read [SKILL.md](../SKILL.md) and
[setup.md](setup.md). Reading a document does not grant installation, network,
account or project permissions. Obtain the applicable user's authorization first.

## 1. Choose the host and inspect existing state

Use a local Codex host with Node.js 22+, Git, a signed-in ChatGPT account and a
supported browser tool for agent-controlled delegation. Obtain Node and Git from
[Node.js](https://nodejs.org/en/download) and [Git](https://git-scm.com/downloads)
or your already-trusted OS package manager. Do not run an unreviewed remote shell
installer. Check `node --version` and `git --version` in the same host that will
run the worker. This fork needs no npm dependencies or native PTY build.

The [current Codex skill documentation](https://developers.openai.com/codex/skills/)
uses `$HOME/.agents/skills` for user-scoped local skills. This guide uses that
layout. Confirm your host's actual discovery path first: an existing custom or
legacy installation is not permission to add a competing `webgpt` skill. A new
session or restart may be needed for discovery. Copy the complete folder; copying
only `SKILL.md` or linking to an actively edited source checkout is not this recipe.

| Purpose | Fresh-install example |
| --- | --- |
| Source checkout | `$HOME/webgpt-source` |
| Installed skill | `$HOME/.agents/skills/webgpt` |
| Private configuration | `$HOME/.config/webgpt/config.json` |
| Private runtime, keys and results | `$HOME/.local/share/webgpt` |
| Assigned project | A separate project directory, never home/config/runtime/installation |

On Windows, `$HOME` is the account running Node, not necessarily the WSL home.
Choose **Windows-native or WSL** for worker/client/configuration and use that host
consistently. Browser identity and file-upload paths are separate: WSL access to a
file does not prove a Windows browser tool can upload it. Do not move an existing
installation between hosts as an incidental repair.

Before running the fresh-install commands, inspect existing skill copies,
`WEBGPT_CONFIG` / `WEBGPT_DATA_DIR`, configuration/runtime directories, owned
services and ports. If an installation exists, use [the update procedure](operations-windows.md#parent-resume-transition-and-rollback)
instead. Do not overwrite a live installation, delete a lock, kill an unknown port
owner or mix upstream terminal state into this file worker.

## 2. Download one revision and copy the whole skill

These commands require **new destination paths**. They capture the downloaded
`main` commit, detach at that exact revision and copy from it. Save the printed
revision and path in your private setup record. Inspect the source before running
it. A source download or copied folder is not proof that setup is complete.

### macOS / Linux / WSL — POSIX shell

<!-- recipe:copy-posix -->
```sh
(
  set -eu
  node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
  git --version
  SOURCE="$HOME/webgpt-source"
  SKILL="$HOME/.agents/skills/webgpt"
  for path in "$SOURCE" "$SKILL"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      printf 'Already exists; inspect instead of overwriting: %s\n' "$path" >&2
      exit 1
    fi
  done
  git clone --branch main --single-branch https://github.com/22nsuk/WebGPT.git "$SOURCE"
  REVISION=$(git -C "$SOURCE" rev-parse HEAD)
  git -C "$SOURCE" checkout --detach "$REVISION"
  mkdir -p "$HOME/.agents/skills"
  cp -R "$SOURCE/skills/webgpt" "$SKILL"
  printf 'Installed %s at %s\n' "$REVISION" "$SKILL"
)
```

### Windows — PowerShell

<!-- recipe:copy-windows -->
```powershell
$ErrorActionPreference = 'Stop'
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22+ is required' }
Get-Command git -ErrorAction Stop | Out-Null
$Source = Join-Path $HOME 'webgpt-source'
$Skill = Join-Path $HOME '.agents\skills\webgpt'
foreach ($Path in @($Source, $Skill)) {
    if (Test-Path -LiteralPath $Path) { throw "Already exists; inspect first: $Path" }
}
git clone --branch main --single-branch https://github.com/22nsuk/WebGPT.git $Source
if ($LASTEXITCODE -ne 0) { throw 'Clone failed; preserve and inspect the partial directory' }
$Revision = git -C $Source rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve revision' }
git -C $Source checkout --detach $Revision
if ($LASTEXITCODE -ne 0) { throw 'Cannot select the recorded revision' }
New-Item -ItemType Directory -Force -Path (Split-Path $Skill) | Out-Null
Copy-Item -LiteralPath (Join-Path $Source 'skills\webgpt') -Destination $Skill -Recurse
Write-Output "Installed $Revision at $Skill"
```

The installed folder must contain `SKILL.md`, `agents/`, `references/`, `scripts/`
and `deploy/`, including every runtime and PowerShell helper. Do not update only
`worker.mjs` or `client.mjs`. The source checkout is for inspection/development;
normal commands below use the separate installed copy.

## 3. Create private configuration and storage

The following recipes intentionally stop for existing WebGPT directories or
overrides. They are for a **fresh, personal-account installation**, not shared
service accounts. If partially completed, inspect the existing directories rather
than deleting them and starting over. Do not run concurrent installers.

### macOS / Linux / WSL

<!-- recipe:config-posix -->
```sh
(
  set -eu
  if [ "${WEBGPT_CONFIG+x}" = x ] || [ "${WEBGPT_DATA_DIR+x}" = x ]; then
    printf 'Existing overrides; inspect the effective configuration first\n' >&2
    exit 1
  fi
  CONFIG_DIR="$HOME/.config/webgpt"
  DATA_DIR="$HOME/.local/share/webgpt"
  for path in "$CONFIG_DIR" "$DATA_DIR"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      printf 'Existing runtime/configuration: %s; use the update guide\n' "$path" >&2
      exit 1
    fi
  done
  umask 077
  mkdir -p "$CONFIG_DIR" "$DATA_DIR"
  chmod 700 "$CONFIG_DIR" "$DATA_DIR"
  (set -C; printf '%s\n' '{"publicMcp":true}' > "$CONFIG_DIR/config.json")
  chmod 600 "$CONFIG_DIR/config.json"
  ls -ld "$CONFIG_DIR" "$DATA_DIR"
)
```

Require mode `0700` on the two owned directories and `0600` on the configuration.
Inspect parent-directory access and existing permissions too; POSIX mode bits do
not establish Windows ACL privacy.

### Windows — PowerShell

<!-- recipe:config-windows -->
```powershell
$ErrorActionPreference = 'Stop'
if ((Test-Path Env:WEBGPT_CONFIG) -or (Test-Path Env:WEBGPT_DATA_DIR)) {
    throw 'Existing overrides: inspect the effective configuration first'
}
$ConfigDir = Join-Path $HOME '.config\webgpt'
$DataDir = Join-Path $HOME '.local\share\webgpt'
foreach ($Path in @($ConfigDir, $DataDir)) {
    if (Test-Path -LiteralPath $Path) { throw "Existing runtime/configuration: $Path" }
}
$Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($Path in @($ConfigDir, $DataDir)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    icacls $Path /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
    if ($LASTEXITCODE -ne 0) { throw 'Cannot establish private directory permissions' }
    icacls $Path
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect directory permissions' }
}
'{"publicMcp":true}' | Set-Content -LiteralPath (Join-Path $ConfigDir 'config.json') -Encoding UTF8
```

The ACL recipe removes inherited entries on these **new directories only** and
grants the current account and Local System access. Inspect `icacls` output for
unexpected explicit entries before starting. Different service accounts need a
reviewed account/ACL plan; do not copy this ACL onto an existing shared directory.

The resulting minimal configuration is:

<!-- recipe:config-example -->
```json
{"publicMcp":true}
```

Omitted values use defaults: MCP `127.0.0.1:43137`, controller
`127.0.0.1:43139`, runtime `$HOME/.local/share/webgpt`. `publicMcp:true` enables the
secret MCP route needed **before public forwarding**. It does not bind the
controller publicly. For custom ports/storage, use distinct available ports and
an OS-appropriate absolute `dataDir`. `WEBGPT_CONFIG` selects an absolute config
file; `WEBGPT_DATA_DIR` overrides the data directory only. Give worker and client
the same effective configuration. See [configuration details](setup.md).

Save JSON as UTF-8; one leading UTF-8 BOM is accepted. PowerShell 5.1
`Set-Content -Encoding UTF8` is supported; its default `>` output is UTF-16 and is
not. Do not paste a Windows path into JSON without escaping backslashes (or use
forward slashes). Do not alter a running service's configuration.

## 4. Start the worker and check the installed copy

Check that both configured ports are free or identify the exact existing WebGPT
owner before starting. If occupied by something else, choose unused ports in the
shared config; never terminate the unrelated owner. Keep this first process in an
owned terminal. The following quoted `$HOME` commands work in POSIX shells and
PowerShell with the layout above:

<!-- recipe:worker -->
```sh
node "$HOME/.agents/skills/webgpt/scripts/worker.mjs"
```

In a second terminal with the same configuration:

<!-- recipe:checks -->
```sh
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" status
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" ready
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" tasks
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" dispatch preflight
```

`listening` and MCP `/health` show liveness only. `ready` must be authenticated;
inspect storage/state/recovery/workspace warnings rather than ignoring them.
`dispatch preflight` checks the parent's Node helper runtime, not browser access.
Run the installed suite from the installed directory:

POSIX shell:

<!-- recipe:installed-tests-posix -->
```sh
(cd "$HOME/.agents/skills/webgpt" && node --test --test-concurrency=2 --test-reporter=tap)
```

PowerShell:

<!-- recipe:installed-tests-windows -->
```powershell
Push-Location (Join-Path $HOME '.agents\skills\webgpt')
try {
    node --test --test-concurrency=2 --test-reporter=tap
    if ($LASTEXITCODE -ne 0) { throw 'Installed tests failed' }
} finally { Pop-Location }
```

Tests use temporary files and local processes; they do not need a signed-in
ChatGPT session or forward a public port. Passing tests do not establish browser
or connector readiness. For source development, run `node tests/run.mjs` at the
source checkout root to include repository and standalone-installation checks.

A foreground worker stops when its terminal/session ends. Persistent operation
requires an owned service/restart method; it is not proved by launching a child
process. Configure it only after the first live probe succeeds and with separate
authorization. [Windows operations](operations-windows.md) covers the optional
bounded supervisor, scheduled-task helpers, stop procedure and deployment limits.

## 5. Expose only the MCP listener over authorized HTTPS

Reuse a verified existing connection and tunnel whenever possible. For a new
connection, `publicMcp:true` causes the worker to create the private
`mcp-path.key`. The valid MCP route is `/mcp/<key>`, **not `/mcp`**.
Before forwarding, verify the local wrong-key and bare routes return 404, a valid
initialize succeeds and an invalid task token cannot call task tools. The
protocol checks are specified in [setup.md](setup.md); do not infer them from a
single health response or a successful test against another runtime.

A Cloudflare Quick Tunnel is one optional development route. Install
[cloudflared from the official distribution](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/),
then run this in another owned terminal (substitute a custom MCP port):

<!-- recipe:forward -->
```sh
cloudflared tunnel --url http://127.0.0.1:43137
```

Use its emitted HTTPS origin plus `/mcp/<key>` as the connection URL. Read the key
privately from `$HOME/.local/share/webgpt/mcp-path.key` (or the configured runtime)
and enter the full URL only into your signed-in ChatGPT connection form. Do not
print the key in shared logs, send the URL in task prompts, navigate to it in a
browser, or capture it in screenshots. Keep `controller.key` local; it is not a
ChatGPT connection credential. Never forward port 43139, the supervisor's control
port, a project folder or a general file server.

Quick Tunnels need no Cloudflare account, but have changing origins and no uptime
SLA; they do not support SSE. This worker uses JSON HTTP responses. HTTPS is
terminated by the forwarding operator: this is public forwarding, not a private
network. Keep the process running and repair the existing ChatGPT URL after an
origin change. See [Cloudflare's limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
A permanent endpoint/service is separate deployment work, not an implicit paid
account requirement. Preserve unrelated cloudflared configurations and tunnels.

## 6. Configure and select the real ChatGPT connection

Use the already-signed-in browser. If necessary and available for your account,
OpenAI's current [Developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode)
places the setting under **Settings → Security and login → Developer mode**.
Open Plugins, create or update the intended WebGPT connection, choose a URL
connection with the full private HTTPS endpoint and **no OAuth authentication**.
Here no OAuth does not mean no protection: the route capability and independent
task tokens enforce the worker's access checks. Do not publish the plugin.

Check the actual endpoint, tool schema and permissions, not just a familiar
connection name. The seven tools must be `get_task`, `read_input`, `list_files`,
`read_file`, `write_file`, `delete_file`, `submit_result`. Refresh stale schemas
after a coordinated worker/client update. Do not replace a compatible connection
or widen unrelated permissions just because the skill was copied again.

In an owned ChatGPT chat, select the actual connection and the requested mode:
`xh` = Extra High or `p` = Pro. Merely mentioning the connector in a message does
not select it. Login, browser-extension approval and mandatory tool confirmations
remain user/platform gates. An agent must use documented browser controls, not
copied cookies or an isolated replacement profile. Missing account access should
be reported, not bypassed or replaced silently with an API model.

## 7. Verify one disposable task end to end

Use a new owned temporary project **outside** the runtime and installed skill.
Create a small ordinary UTF-8 fixture there. Write the following payload privately
to `$HOME/.local/share/webgpt/setup-task.json`, replacing the unique ID and absolute
project root. On Windows, use a path such as `C:/Users/you/...` in JSON. Preserve an
existing setup payload/record instead of overwriting it. This file is a private
controller input; it is not a file to publish or upload wholesale.

<!-- recipe:probe-json -->
```json
{
  "id": "setup-check-REPLACE-UNIQUE",
  "instructions": "Verify this owned disposable project: create, read, edit and delete a text file; prove a stale-revision write is rejected without changing current bytes. Save the results, receipts and limitations. Do not access unrelated projects.",
  "inputs": {},
  "workspace": {
    "root": "/REPLACE/WITH/ABSOLUTE/TEMP/PROJECT",
    "mode": "edit"
  }
}
```

Register from the same Node host:

<!-- recipe:probe-register -->
```sh
node "$HOME/.agents/skills/webgpt/scripts/client.mjs" register "$HOME/.local/share/webgpt/setup-task.json"
```

The response contains a private task token. Give **only that token**, the selected
connector and the bounded verification request to the owned ChatGPT conversation.
Do not send the controller key or full connection URL. Let the worker use its
seven tools to complete the exercise and `submit_result`. Verify evidence in the
actual relevant tool calls, not just in the model's summary.

| Checkpoint | Required evidence |
| --- | --- |
| Browser and dispatch | Actual selected mode/connector, owned chat/tab, one confirmed user message |
| Granted file operations | Actual create/read/edit/delete calls and resulting on-disk bytes |
| Conflict protection | A real stale-SHA write rejection and unchanged current bytes |
| Saved result | Completion receipt, full saved artifact and verified SHA-256 |
| Recovery | Original bytes/receipts for changed or deleted fixture files |
| Collection and retirement | Successful verified collection, no outstanding owned task, rejected retired token |
| Chat cleanup | Retained chat URL, completed final answer, only owned tabs closed |

After inspecting the evidence, use the original ID and installed path:

<!-- recipe:probe-collect -->
```text
node <skill>/scripts/client.mjs reconcile <task-id>
node <skill>/scripts/client.mjs collect --resume <task-id>
node <skill>/scripts/client.mjs tasks
```

`collect --resume` verifies bytes and can acknowledge an eligible uncollected
result. It neither reruns tests nor resends work. `tasks` alone does not prove
retired-token rejection: verify that separately with the original task token.
Wait for the final chat answer to finish independently of the result callback.
Retain the chat by default; closing its owned tab is not deleting the chat.

Keep one private setup record with revision/paths, worker and tunnel ownership,
start/stop method, connection name, checkpoint results and private evidence
references. Record each as `PASS`, `FAIL` or `NOT_RUN`; do not store keys in the
record. Preserve interrupted work and resume the **same** task with `ready`,
`reconcile` and the original chat; uncertain delivery never authorizes a resend.
Explicitly cancel an abandoned registration only after preserving its evidence.
Clean up only owned temporary project files after verification; retain recovery
records and chats unless their deletion is separately requested.

The richer [verification workflow](verification.md) and [parent acceptance guide](parent-acceptance.md)
are available for later feature checks. Local `PASS` never becomes live `PASS`.
No browser control means the agent-controlled path remains incomplete even if a
human successfully used the connector manually.

## 8. Operate, update or uninstall without losing evidence

Use `read` grants for ordinary review and `edit` only for authorized changes.
File tools handle UTF-8 text up to 1 MiB per file, not arbitrary binaries or shell
commands. [Workspace](workspace.md) documents pagination, whole-file hashes and
protected paths. The boundary does not filter every project secret or isolate a
hostile local process. Remote PR work uses [separate GitHub tools](github-workflow.md).

For updates, inspect running/uncollected tasks, freeze new dispatch, resolve work,
stop the owned worker and restart owner, verify exit, back up consistently, replace
all matching installed files, restart with the intended identity/configuration,
and verify the existing tunnel/connection plus a real probe. Keep normal working
connections during code-only updates; do not delete state or locks to clear errors.
Follow [transition and rollback](operations-windows.md#parent-resume-transition-and-rollback)
and [recovery integrity](recovery-integrity.md), including legacy-version limits.

To uninstall, first preserve/collect results and stop only the identified worker,
its restart owner and any exclusively owned tunnel. Remove only the intended skill
copy/registration and obsolete ChatGPT connection. Do not stop a shared tunnel or
remove another tool's configuration. Runtime data, keys, receipts, recovery copies
and retained chats are **not** automatically deleted. A deliberate credential
retirement or data-deletion request is separate from removing the skill files.

For failed uploads see [file uploads](file-uploads.md); for readiness/recovery
errors see [diagnostics](diagnostics.md) and [backup safety](backup-safety.md).
Report the failed stage and exact observed limitation, not a blanket "installed"
or "permissions unavailable" conclusion.
