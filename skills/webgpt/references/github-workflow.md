# GitHub publication through a separate connected app

Use this guide when the user assigns web ChatGPT branch/commit/PR publication or CI and review
follow-through. The WebGPT MCP remains a project-text/result bridge. Its seven-tool inventory and
lack of shell access do not describe the capabilities of a separately connected GitHub app.

## Discover the current operation, not a presumed limitation

Select the existing GitHub app in the same task chat alongside the project connector when both are
needed. Inspect the available tools or the host's supported tool search before reporting a missing
capability. A plugin title, old skill description, user report or parent-session tool inventory is
useful context; the worker must still discover its own callable operations. Do not treat missing
local `git`/`gh` as a failed GitHub authorization check.

Discover the operations required by the assignment: repository/ref reads, branch and file or Git
object writes, commit/ref updates, PR creation, commit-specific CI runs/jobs/logs, and review
comments/threads. These may be lazy-loaded and need separate searches. Current tool schemas govern
arguments, supported actions and pagination; do not invent names or assume all GitHub apps expose
the same features. Instructions that universally require CLI for commits, pushes or Actions logs
must be checked against those schemas before using that fallback.

Distinguish an undiscovered tool, an unavailable operation, repository authorization denial,
mandatory approval, and an invalid call. A failure of one operation does not establish that all
GitHub writes are impossible. Record the attempted operation and sanitized result; honor actual
denials and approval gates. Do not broaden permissions, expose credentials, bypass policy or add a
shell bridge to make a capability assertion true. A user-confirmed working route is a reason to
investigate the existing connection, not permission to fabricate a successful call.

## Keep publication ownership and repository state explicit

When the user requests direct worker publication, the worker owns that operation through its
authorized GitHub tools. The parent must not silently create the PR and credit it to the worker.
Assign parent assistance only for an actual uncovered step, preserving the user's chosen owner.
Local execution and GitHub publication are separate: an inability to run local tests does not block
an otherwise authorized remote branch/commit/PR flow. Report local tests as NOT_RUN and distinguish
them from CI tests that actually ran.

Resolve the exact repository, base revision and task branch before writing. Reuse an existing task
branch/PR only after reconciling ownership and current state. Preserve unrelated files and changes.
For Git-object operations, retain the existing tree, preserve file modes, create the intended commit
with the observed parent, and update only the task branch without force. If a write response is lost
or a branch has advanced, inspect the existing ref/commit/PR before another mutation; do not assume
the write failed or overwrite concurrent work. A local workspace receipt does not prove remote
publication: compare the final remote diff with the intended files and record the commit SHA.

The WebGPT task token grants no GitHub rights. Collection retires that local token; it does not
revoke the separately connected GitHub account. Stay within the assigned repository/actions and
stop all assigned changes at task completion. PR creation does not authorize merging, deployment,
branch deletion or permission changes.

## Finish the requested PR outcome

If the assignment includes CI and review follow-through, a patch report or PR draft is intermediate
work. Keep file authority until necessary edits are finished; do not call `submit_result` simply
because an initial patch exists. Mark a PR ready when the user's review request requires it and the
candidate is ready, then inspect review activity rather than treating an untriggered review as clear.

Check the actual final head SHA, required CI runs/jobs and conclusions, review completion, comments
and unresolved threads. Observe each tool's first-page/attempt/filter limits; an empty response or
absence of inline comments alone does not prove completion. Address actionable findings, preserve
failure evidence, and check the new head after a fix. Do not weaken checks or repeatedly rerun an
unchanged failure to obtain green results. If reviews are still pending or inaccessible, keep that
condition explicit instead of reporting no findings.

Report the PR URL, head SHA, actual CI and review evidence, changes made for findings, and remaining
limitations. Submit the saved result once the assigned work is complete or a concrete blocker has a
recorded disposition, then finish the user-facing answer. Follow [chat-lifecycle.md](chat-lifecycle.md):
result collection and token retirement do not justify stopping an unfinished final answer. If new
file work is needed after submission, use a genuine follow-up assignment in the retained chat.
