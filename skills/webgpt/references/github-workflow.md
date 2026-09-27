# GitHub publication through a separate connected app

Use this guide when the user assigns web ChatGPT branch/commit/PR publication or CI and review
follow-through. The WebGPT MCP remains a project-text/result bridge. Its seven-tool inventory and
lack of shell access do not describe the capabilities of a separately connected GitHub app.

## Discover the current operation, not a presumed limitation

Select the existing GitHub app in the same task chat alongside the project connector when both are
needed. Before dispatch begins, observe each required app selected and record their identities in
the existing private task ledger's parent-owned fields. The dispatch boolean `connectorSelected`
does not identify or prove selection of both apps; do not extend its strict observation schema.

For an assigned publication, use this order before declaring a capability blocked or retrying a write:

1. Discover the current worker's own callable operations through its available tools or supported
   tool search: repository/ref reads, branch and file or Git-object writes, commit/ref updates and PR
   creation. Also discover CI runs/jobs/logs and review comments/threads when assigned. Tools may be
   lazy-loaded; inspect current schemas and pagination. A plugin title, old skill description, user
   report or parent-session inventory does not establish the worker's capabilities.
2. Read the exact repository and base ref through the intended GitHub connection without mutation.
   Confirm accessibility and the base SHA before writing. A successful read proves that read only,
   not write permission; do not create a probe branch or PR merely to test access.
3. Keep local workspace/container evidence separate from the GitHub connection. Missing `git`/`gh`,
   container DNS failures and WebGPT MCP's lack of Git operations do not prove connector failure.
   Check CLI-only instructions against the discovered GitHub schemas before choosing a fallback.
4. If an authorized write fails, diagnose that specific call using its sanitized response. For a
   `403`, distinguish repository access, the endpoint's required `Contents` or `Pull requests`
   permissions, `Workflows` permission when applicable, and branch protection/rulesets. Also check
   for rate limits; a `403` alone is not proof of missing write permission. Use response details and
   exposed headers such as `X-Accepted-GitHub-Permissions` when available, without assuming the
   connector exposes them. Honor denials and required approvals; do not broaden permissions.
5. Before retrying a failed or ambiguous write, respect any rate-limit wait and re-read the affected
   ref, commit or PR through the same connection. Match the intended branch, parent/tree or PR
   head/base to determine whether the write already succeeded. Continue from confirmed state; retry
   only an operation shown not to have taken effect after addressing its failure. If the outcome
   cannot be determined, retain the evidence and report that specific blocker instead of repeating
   the mutation, force-updating a ref or creating a duplicate branch/commit/PR.

For response-specific permission and rate-limit interpretation, consult
[GitHub's REST API troubleshooting guidance](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).
Do not invent tool names or assume all GitHub apps expose the same features.

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
with the observed parent, and update only the task branch without force. Re-read a branch that has
advanced and reconcile concurrent work before another mutation; do not overwrite it. A local
workspace receipt does not prove remote publication: compare the final remote diff with the
intended files and record the commit SHA.

When the worker also edited a local checkout through MCP, remote commits do not update that
checkout's HEAD or index. The parent must fetch the published ref and compare HEAD, index, current
files and task receipts against the remote commit, preserving unrelated staged and unstaged work.
Reconcile a matching task-owned checkout through authorized local Git operations, or record an
explicit retained-work disposition and the authoritative published checkout. Do not blindly reset,
clean or duplicate-commit the edits. Record the resulting local/remote revisions and any remaining
changes before reporting integration complete; remote publication alone is not local reconciliation.

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
and unresolved threads. Also inspect required check runs/status contexts or authoritative PR check
and merge state: external checks and legacy commit statuses may not be Actions jobs. If required
status evidence is inaccessible, report that limitation rather than calling Actions green a complete
CI verdict. Observe each tool's first-page/attempt/filter limits; an empty response or
absence of inline comments alone does not prove completion. Address actionable findings, preserve
failure evidence, and check the new head after a fix. Do not weaken checks or repeatedly rerun an
unchanged failure to obtain green results. If reviews are still pending or inaccessible, keep that
condition explicit instead of reporting no findings.

Report the PR URL, head SHA, actual CI and review evidence, changes made for findings, and remaining
limitations. Submit the saved result once the assigned work is complete or a concrete blocker has a
recorded disposition, then finish the user-facing answer. Follow [chat-lifecycle.md](chat-lifecycle.md):
result collection and token retirement do not justify stopping an unfinished final answer. Any new
project or GitHub mutation after submission requires a genuine follow-up assignment in the retained
chat, including GitHub-only corrections or review-thread changes. Use new task authority for local
bridge access; a still-connected GitHub account does not extend the completed assignment.
