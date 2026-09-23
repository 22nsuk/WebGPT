# Fork policy and upstream integration

This fork keeps project-scoped text-file access and retains task chats by default.
It does not expose a shell or give Web ChatGPT the worker user's full OS permissions.

## Integration baseline

Reviewed upstream `Nhahan/WebGPT` at
`a2a4c4f15b62813cc87700b15b34480146775b04` against this fork at
`d79c61ba4a28ab7f80a0104ef85584abd9298d44`.

Selectively adapt upstream's task-scoped waits, quiet HTTP renewal and saved-result
hash verification. Keep the existing seven MCP tools, workspace read/edit grants,
revision checks, recovery journals, 15-minute backup checks and retained chats.
A collected artifact has verified bytes; it is not automatically correct code or
proof that reported tests ran. Codex still reviews the relevant evidence and checks
integration changes when necessary. Keep user-language prompts, useful same-chat
follow-ups and the existing browser tool's actual permission gates.

Do not merge the upstream terminal replacement, `webgpt open` terminal leases,
`node-pty` dependency or automatic chat deletion into this security boundary.
A working directory is not a sandbox. A future terminal mode needs a separately
reviewed isolation design and explicit authorization, not a silent migration of
existing file grants. Track selective adaptations as ordinary fork commits, not
a merge that implies the terminal migration and all other changes were adopted.

## Selective review of faithforone/WebGPT

Reviewed `faithforone/WebGPT` at `b8206c57866cf574fdb65aa2aadc146a4ad2e469` against this fork's
`ca0a31068c0f5adbf68f20af0f3c0dc01daa9a15` baseline. Its project-first usage explanation and
bounded file reads are useful here. The usage guide now shows direct repository review and
implementation instead of requiring pasted source. Optional `read_file` windows preserve our
existing full-file default, whole-file SHA, grants, UTF-8 limits and path/link checks. They return
complete lines and explicit partial/range metadata; read the full file before a replacement write.

The reference fork intentionally provides unrestricted OS-user terminal commands, `webgpt open`
sessions and patch editing without this fork's revision/recovery contracts. Those are different
authority and lifecycle choices, so their implementation is not imported. Its mandatory credentialed
tunnel/public-origin setup is also outside this change; existing authorized transport is preserved.
No claim is made about measured token savings or live connector support before schema refresh and
an actual installation probe. These are ordinary selective fork changes, not an upstream merge.

## Selective review of upstream, captainsoldier and bizstoa1

The [2026-09-23 comparison](upstream-review-2026-09-23.md) records pinned source
revisions and adoption decisions. Adopt exact-path GET/HEAD liveness probes and
opt-in metadata-only diagnostics, not terminal transport or automatic deletion.
Use [diagnostics.md](diagnostics.md) for bounded, task-scoped inspection when a
connection fails. Diagnostic observations never replace saved-state authority,
result verification, permission checks or the retained-chat recovery process.

## Terminal review: security and practical work

The upstream terminal is useful: it supports builds, tests, Git, binary tools and
interactive programs in one delegated session. Its task tokens check ownership,
and completion/cancellation attempts to stop owned terminal sessions. These are
useful lifecycle controls, but they do not confine the commands to a project.

At the reviewed commit, `terminal.mjs` passes `process.env` to the shell, accepts a
different absolute cwd, and runs as the worker's OS user. A fixture-only Windows
probe confirmed parent-directory reads, `.git/config` writes, cwd overrides and
environment inheritance. This is the upstream tool's documented authority, not
an authentication bypass or automatic privilege elevation. It can reach whatever
that OS user can reach, potentially including other projects, credentials and the
worker's controller data. Running an elevated worker increases that exposure.
Task-token separation therefore does not isolate mutually untrusted shell tasks.
There is also no command timeout or output-buffer limit in the reviewed terminal;
an unattended command can keep running or consume the shared worker's memory.

Keep the file worker as this fork's default and supported mode. The practical
tradeoff is that WebGPT can edit project text and return evidence, but cannot run
its own build, test, Git or interactive commands. Codex performs authorized local
verification and Git integration, then returns relevant results for a correction
when needed. Scoped waits and collection reduce coordination overhead without
expanding the delegated task's OS authority. No performance saving is promised.

Review changed test/build scripts, package lifecycle hooks and other executable
inputs before the parent runs them. A file-only delegate can still write code
that executes with the parent's permissions later. Do not blindly run commands
from its report; use the project's verified workflow and the user's authorized
execution environment. Untrusted execution needs a disposable isolated environment
with only intended project data, no host credentials and controlled network access.
The existing file tools are not a substitute for that execution boundary.

If direct terminal delegation becomes necessary, review it as a separate execution
mode with OS-enforced isolation, scoped mounts/permissions, minimal environment,
credential and network controls, bounded resources, and tested process cleanup.
Verify those properties on each supported OS before adopting it. A cwd setting,
command denylist, prompt warning or opt-in switch alone does not supply isolation;
do not reinterpret an existing read/edit grant as terminal permission.

## Compatibility and operation

Update an idle, identified fork worker and client together; preserve runtime data,
configuration, active tasks and customizations. Existing registration JSON, task
tokens, results and recovery records remain compatible. No-argument `wait` keeps
its bounded, global snapshot behavior. Explicit task-ID waits are scoped and renew
HTTP requests inside the client until an actionable event or settlement.
Stopping a wait does not cancel the task or browser generation. Cancel an abandoned
task separately and preserve partial output. Neither command wakes an exited Codex
session or changes the default chat-retention policy.

Do not treat an upstream terminal/open data directory as a file-worker migration.
Inspect and retire its active sessions with the matching upstream worker first;
never overwrite or silently reinterpret live grants.

## Remaining boundaries

Read-only prevents changes, not disclosure: project text files may contain secrets.
Use a secret-free project snapshot or explicitly supplied inputs for sensitive
reviews. The filesystem checks assume a cooperative local workspace; they are not
an OS sandbox against hostile concurrent filesystem changes. Quick Tunnel, browser
and ChatGPT connector behavior still require an actual end-to-end probe. Unit and
local HTTP tests alone do not establish that connection is ready.
