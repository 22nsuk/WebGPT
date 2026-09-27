# WebGPT

**English** · [한국어](README.ko.md)

Delegate a bounded task to your signed-in web ChatGPT, give it scoped access to
project text files, and collect a saved result for review. The parent agent owns
scope, permissions and integration; web ChatGPT owns the assigned work.

This is the **file-scoped fork** of [Nhahan/WebGPT](https://github.com/Nhahan/WebGPT).
It is a local Codex skill plus a small Node.js worker, not a model API client or a
browser extension. It uses your available ChatGPT modes; it does not provide a
subscription, bypass usage limits or guarantee quota savings.

## Choose an installation route

| Route | Start here |
| --- | --- |
| Have an agent install and verify it | [Agent-assisted installation](#agent-assisted-installation) |
| Install it yourself on Windows, macOS or Linux | [Manual installation](skills/webgpt/references/install-manual.md) |
| Already have a working installation | [Safe updates](#updates-and-recovery), not the fresh-install commands |
| Compare this fork with upstream | [Revision-pinned comparison](skills/webgpt/references/upstream-review-2026-09-28.md) (Korean) |

## What it does—and does not do

| Capability | This fork |
| --- | --- |
| Research, analysis and writing | Web ChatGPT's reasoning and separately available, authorized tools |
| Local project review | A task-scoped `read` grant |
| Local implementation | An `edit` grant for direct UTF-8 file creation, replacement and deletion |
| Conflict protection | Whole-file SHA-256 preconditions; stale writes are rejected |
| Completion and recovery | Saved results, scoped waits, integrity-checked collection and retained evidence |
| Shell, local Git, test execution through the file worker | **Not provided.** The parent runs local checks |
| Remote branch/commit/PR operations | Possible through **separately connected GitHub tools** and their permissions |
| Arbitrary binary files or recursive deletion | Not supported by the file tools |

The worker exposes seven MCP tools: `get_task`, `read_input`, `list_files`,
`read_file`, `write_file`, `delete_file`, `submit_result`. Text/research tasks can
omit a project grant; browser-only delegation can omit the worker, but then has no
worker completion event or saved-result collection.

File grants exclude Git metadata, the running installation, operational
configuration and private runtime. They are **not a general secret filter**:
ordinary files such as a project's `.env` can be accessible inside a granted root.
Choose a project that is safe to share. Do not grant your home directory.

## Prerequisites

Use Node.js **22 or newer**, a local Codex environment that discovers skills, and
an available signed-in ChatGPT account/mode. Agent-controlled delegation also
needs a supported browser-control tool connected to that signed-in browser.
Installing this skill does not install a browser extension or establish browser
control automatically. Git is used by the manual download recipe.

For ChatGPT to access the local worker, you also need permission to configure a
remote MCP connection and an authorized HTTPS forwarding service. An existing
compatible connection is preferable; the manual guide includes a Cloudflare
Quick Tunnel option. No OpenAI Platform API key or model API billing is required
by this worker. Account/workspace restrictions and action-time confirmations
still apply.

The file worker uses Node built-ins: **no `npm install`, `npm ci`, `node-pty` or
native terminal build is required for this fork**. Upstream terminal installation
instructions are not interchangeable with these instructions.

## Agent-assisted installation

Paste this into your **local Codex agent**, not into a WebGPT worker that has yet
to be installed. Read the authorization before sending it; narrow it when needed.

```text
Install the file-scoped WebGPT skill from https://github.com/22nsuk/WebGPT.
Resolve main to a commit, record it, and install the complete skills/webgpt directory
from that same revision. Read SKILL.md, references/install-manual.md and
references/setup.md before changing anything. Do not install the upstream terminal worker.

Check for an existing installation, custom paths, running tasks and working connections
first. Preserve them; use the stopped-update procedure instead of overwriting a live install.
For a fresh installation, use the host's supported user skill directory and keep the
installed copy, private configuration/runtime and editable projects separate.

I authorize the local worker and HTTPS forwarding, transferring its private connection
URL only into my signed-in ChatGPT connection settings, and read/create/edit/delete
access only to projects I explicitly assign. Set up supported missing prerequisites.
Do not create paid services, publish a plugin, expose the controller or grant shell access.
Ask only for sign-in, required approvals or unresolved choices that genuinely require me.
This authorization does not bypass mandatory action-time confirmations.

Run the installed tests and a real browser/connector probe on an owned temporary project.
Verify create/read/edit/delete, actual stale-revision rejection, saved-result integrity,
collection and retired task access. Retain the test chat, let its final answer finish,
then close only its owned tabs. Never delete or archive chats without my explicit request.
Record the installed path/revision, start/stop method and PASS/FAIL/NOT_RUN evidence
without credentials. Report file installation, local readiness, browser access and live
end-to-end verification separately; do not call partial setup complete.
```

The agent procedure is in [setup.md](skills/webgpt/references/setup.md). It covers
reuse of existing connections, tool discovery, user-only approvals and resuming
the **same** interrupted installation. A local `/health` response is not proof of
browser control, ChatGPT connectivity or successful delegation.

## Manual installation

The [English manual](skills/webgpt/references/install-manual.md) and
[한국어 설치 안내](skills/webgpt/references/install-manual.ko.md) include copyable
POSIX-shell and PowerShell commands, prerequisites, private-directory permissions,
UTF-8 configuration, worker startup, HTTPS connection setup and a live acceptance
exercise. They also distinguish a fresh install from an update.

The sequence is: download and record one revision → copy the **entire** skill →
configure private storage → start and check the worker → connect ChatGPT → verify
one disposable project task. File copying alone completes only the first part.

## Use

In a local Codex session that has loaded this skill:

```text
webgpt p Review this repository for likely defects and prioritize improvements.
Use read-only access. Do not change files; cite the relevant paths and evidence.
```

```text
webgpt xh Implement the search filter in this project and update relevant tests.
Preserve unrelated behavior. Codex should review the diff and run the necessary local checks.
```

`xh` / `xhigh` = **Extra High** (default); `p` / `pro` = **Pro**. Verify the
requested mode in the actual UI; do not silently substitute another mode. Upstream's
`m`, `h` and `webgpt open` routes are not implemented by this fork's skill.

Assign one coherent outcome, relevant context, ownership and acceptance criteria;
let the worker choose the investigation and edits within that scope. Use disjoint
write ownership for parallel tasks. Do not upload a repository to replace working
file access. Required images/binaries use the separate
[attachment workflow](skills/webgpt/references/file-uploads.md).

For publication, explicitly assign the target repository and PR outcome. Discover
the available GitHub tools before deciding which participant publishes. The file
worker's lack of shell/Git is **not** evidence that remote GitHub writes are
unavailable. Publication also requires checking the final head's CI and relevant
reviews; see [GitHub workflow](skills/webgpt/references/github-workflow.md).

## Safety and completion

Retain task chats by default, including setup tests, failures and recovery chats.
Delete a chat only when the user explicitly requests deletion of that chat.
Closing a task-owned tab does not delete its chat or retire a task token.

The parent verifies the result and relevant changes, then collects the saved
artifact with SHA-256 verification. **Integrity is not correctness** and does not
prove reported tests ran. Observe final chat-answer completion separately before
closing the owned tab. Use `read` grants for reviews; do not upgrade them silently.

Keep task tokens private to their assigned conversations. Never publish the full
MCP URL, `mcp-path.key`, `controller.key`, service credentials or recovery copies.
Forward only the MCP listener, **never** the controller or service-control port.
Quick Tunnels are public development forwarding, not a private network or a
permanent endpoint. A project grant is not hostile-process/OS isolation.

## Updates and recovery

Before updating, inspect `client.mjs tasks`; an empty `status` event queue does
not establish idleness. Collect or explicitly resolve outstanding work, stop the
identified worker **and** its restart owner, verify exit, preserve a consistent
private backup, and replace the complete installation with a matching revision.
Keep a healthy existing tunnel/connection during a code-only update. Follow the
[transition and rollback procedure](skills/webgpt/references/operations-windows.md#parent-resume-transition-and-rollback).

Run these with `<skill>` replaced by the installed directory:

```text
node <skill>/scripts/client.mjs ready
node <skill>/scripts/client.mjs tasks
node <skill>/scripts/client.mjs dispatch preflight
node <skill>/scripts/client.mjs reconcile <task-id>
node <skill>/scripts/client.mjs collect --resume <task-id>
```

These commands have different purposes: `ready` checks authenticated local
readiness; `tasks` inventories work; `dispatch preflight` checks the parent helper
runtime; `reconcile` inspects retained evidence. `collect --resume` can acknowledge
an eligible uncollected result—it is not always read-only. None resends a browser
message or proves live browser readiness. Preserve uncertain sends, locks,
journals and result candidates; never reset them to manufacture a PASS.

| Symptom | First distinction to make |
| --- | --- |
| Skill is not discovered | Actual host skill directory, duplicate installs, new session/restart |
| `/health` works but tools fail | Authenticated `ready`, actual endpoint, selected connector, task grant |
| Upload fails despite file-URL access | Correct extension/profile and actual upload capability, not the toggle alone |
| Connection stops after tunnel restart | Changed HTTPS origin; repair the existing connection before new work |
| Result exists after an interruption | Reconcile the original task; do not re-register or resend blindly |
| Local test PASS but no live proof | Report live verification as `NOT_RUN`, not successful installation |

## Documentation and development

| Topic | Guide |
| --- | --- |
| Human installation / agent setup | [English manual](skills/webgpt/references/install-manual.md) · [한국어](skills/webgpt/references/install-manual.ko.md) · [Agent setup](skills/webgpt/references/setup.md) |
| Practical prompts and task design | [Usage (한국어)](skills/webgpt/references/usage.md) · [Parent workflow](skills/webgpt/references/parent-workflow.md) |
| Tool contracts and limits | [Workspace](skills/webgpt/references/workspace.md) |
| Sending, attachments and cleanup | [Dispatch](skills/webgpt/references/dispatch.md) · [Uploads](skills/webgpt/references/file-uploads.md) · [Chat lifecycle](skills/webgpt/references/chat-lifecycle.md) |
| Results, recovery and deployment | [Collection](skills/webgpt/references/collection-details.md) · [Recovery integrity](skills/webgpt/references/recovery-integrity.md) · [Backup safety](skills/webgpt/references/backup-safety.md) · [Windows operations](skills/webgpt/references/operations-windows.md) |
| Diagnosis and acceptance | [Diagnostics](skills/webgpt/references/diagnostics.md) · [Verification](skills/webgpt/references/verification.md) · [Parent acceptance](skills/webgpt/references/parent-acceptance.md) |
| Architecture and upstream policy | [Browser-use comparison](skills/webgpt/references/browser-use-comparison.md) · [Fork policy](skills/webgpt/references/fork-policy.md) · [Upstream comparison](skills/webgpt/references/upstream-review-2026-09-28.md) |

From a source checkout, run:

```sh
node tests/run.mjs
```

This runs the repository suite, then a standalone installed-skill copy. CI covers
Windows, macOS and Linux with Node 22, 24 and 26; these are local automated tests,
not signed-in ChatGPT acceptance tests. See [CI maintenance](.github/ci-maintenance.md).
Keep both READMEs and manual guides aligned; documentation tests check local links,
anchors and matching installation command blocks. No production service, browser
session or public tunnel is required for those documentation tests.

## Attribution and license

Based on [Nhahan/WebGPT](https://github.com/Nhahan/WebGPT), with selected ideas from
[faithforone/WebGPT](https://github.com/faithforone/WebGPT) as documented in the fork
references. See [LICENSE](LICENSE). Upstream and this fork intentionally have
different authority and retention policies; do not mix their live runtime state.
