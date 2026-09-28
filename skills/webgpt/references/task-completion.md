# Complete the task, not just a Git workflow

Worker-first completion applies to **all task types**: ordinary local folders,
provided text, research, uploaded data, documents, media and connected-app work as
well as repositories. Git, a remote repository, a commit and CI are not prerequisites.
Use this guide when choosing an unfamiliar task route or resolving an ownership gap,
not as an extra checklist for every healthy task. The normal lifecycle remains in
[parent-workflow.md](parent-workflow.md).

## Scope comes from the requested outcome

Unless the user narrows the assignment, the worker owns all feasible in-scope
inspection, analysis, creation/editing, applicable validation, correction and delivery.
Do not stop at advice, a plan, a script or a first draft when the requested finished
result can be produced with the worker's actual tools. Conversely, a requested plan,
review or draft is the complete deliverable; do not turn it into edits or publication.
Resolve routine implementation choices from the inputs rather than asking the parent
to decide every step. Stop when the outcome and its checks are satisfied, not when
all available tools or quota have been consumed.

This default is not blanket permission. Honor user restrictions, source/account
permissions, required confirmations and the actual task's scope. For example,
creating a requested file does not authorize sending it to other people, public
sharing, deleting unrelated originals, spending money or changing permissions.
An explicitly requested supported app edit should be performed, not replaced by
instructions for the parent to copy; an unrequested external action must not be
added merely because the tool exists. Never bypass a denial through another route.

## Choose inputs and destination, then the needed capabilities

Start with the actual inputs and where the result must end up, not a repository
search or a default local checkout. Discover relevant tools and read applicable
skills in the worker's conversation as needed. The parent's inventory, a plugin name
or a local path is not proof that the worker can use it. Keep one authoritative
input version and destination for each output; mixed sources can stay in their
native locations. Do not force an entire multi-source task into one repository.

| Actual task/input | Worker route and completion | Parent-only gap, when real |
| --- | --- | --- |
| Non-Git local folder of supported text/code | Use its `read`/`edit` workspace grant; inspect, change and validate with available authorized tools. Preserve unrelated files and whole-file SHA preconditions. No `git init`, commit, push or CI requirement. | Host-specific execution or unavailable dependencies; lack of Git alone is not a gap. |
| Provided text or public research | Use the supplied text/named inputs and permitted research tools; finish the requested answer, translation, comparison or report and check sources/faithfulness. No workspace is needed. | Missing private context or a genuinely unresolved user decision, not routine source reading. |
| Uploaded CSV/XLSX or other data | Read the actual supplied version; use available analysis tools for transformations/calculations, validate relevant counts/totals/formulas and return the requested data/report files. Do not merely return code for the parent to run. | An inaccessible input, unsupported operation or required host-only source. |
| Documents, PDF, slides, images or other media | Use supported artifact/analysis tools and applicable skills to produce the requested format, inspect content and rendering where relevant, and correct issues before delivery. A text outline is not a requested finished file. | A missing renderer, native application or actual original; state exactly which check or format is unavailable. |
| Connected document, spreadsheet or record | Read the exact source through the authorized app, make the requested changes and verify the resulting object/version when supported. Return its real reference; do not make a redundant local copy by default. | A specific unavailable action, denied permission, unresolved conflict or required user approval. |
| Git repository/PR | Use the task's actual local inputs or authorized remote branch, then [development](development-loop.md) and [GitHub](github-workflow.md) completion rules. | Only the unavailable operation or required local integration, not all verification by default. |

The workspace is an ordinary allowed directory, not a Git registration. The MCP
file tools still accept only supported UTF-8 text up to 1 MiB per file; they do not
provide a shell or transport binary artifacts. A separate sandbox or app may work
with larger/binary inputs within its own actual limits and permissions. Use that
route when available rather than delegating every native conversion to the parent.
Never encode a binary into text to evade the bridge's limits or claim its write
receipt saved the original binary format.

Keep already accessible sources in place. Use named `inputs` for explicitly supplied
text, the existing [attachment route](file-uploads.md) for required visual/binary
inputs, and authorized app reads for connected content. Do not copy sensitive data
to a new service or publish local inputs merely to obtain execution. Where evidence
exists only on the parent's host, request one bounded preparation/handoff using
[artifact-inputs.md](artifact-inputs.md) when appropriate; the worker still owns the
subsequent analysis and output. A summary or hex header cannot replace required
visual evidence or an editable original.

## Check the result in its own terms

Bind checks to the actual input and output. For non-Git files, use their available
identity and whole-file hashes when bytes can be read; for apps, use the actual
object ID/version or observed readback; for research, use sources and access dates
when relevant. Do not demand a commit SHA or invent a hash/version for provided text
or an app that exposes none. A receipt alone is not content validation, and a hash
alone is not correctness. Record missing version/readback evidence honestly.

Choose checks appropriate to the deliverable: preserved meaning/structure for a
rewrite; units, missing values and reconciliation for data; formulas and calculated
outputs for a workbook; requested sections and visible layout for a document; the
actual changed fields for an app edit; relevant execution/tests for code. Reopen or
render the final artifact when supported and materially useful, rather than checking
only a precursor. Fix discovered issues inside the same active assignment. Later
changes invalidate affected checks. Use PASS/FAIL/NOT_RUN or equivalent truthful
statements; do not require a test command, exit code or CI for work with no execution.

The parent reviews the compact outcome, important evidence and remaining risk. Reuse
sufficient worker checks rather than having the parent rebuild files, recalculate
all data or repeat the research. Additional independent or environment-specific
checks remain necessary when the user requires them or the evidence/risk warrants
them. User-requested quality and acceptance criteria are not reduced to save work.

## Delivery is part of completion

Return the requested answer or finished artifact, its actual location/reference,
relevant input/output identity, checks, limitations and the smallest remaining parent
action (or none). Keep this summary compact without truncating a requested full report.
A file output needs a real attachment/download mechanism or an authorized app/workspace
reference that the intended recipient can access; an invented link or a sandbox path
alone is not delivery. A successful write to a worker sandbox does not update the
parent's disk or the original connected document.

For a required local binary destination that the worker cannot write, preserve the
finished artifact and identify the exact transfer needed through an authorized route.
The parent may retrieve/place it without recreating its contents. Report creation,
validation and local placement separately; do not claim the requested local save
completed before it did. If delivery is blocked, disclose that gap while preserving
all completed work. Do not silently replace a required file with instructions or
make the parent redo feasible generation. A user-only download/approval may still
be a genuine remaining step.

`submit_result` saves the textual deliverable/evidence, not attachments or app
objects. Include accessible artifact references and any unresolved delivery in its
text; do not invent new result fields or status values. Finish all feasible assigned
work and corrections before terminal submission. A concrete blocked remainder uses
the existing recorded-disposition lifecycle, not a new waiting callback. After
submission, new edits/app writes need a genuine follow-up assignment; token retirement
and [final chat-answer completion](chat-lifecycle.md) remain separate. A later transfer
must not depend solely on access through a token that collection will retire.

## Brief and acceptance examples

The parent may read the installed guide while the worker cannot. Put the relevant
outcome, input access, destination and constraints in the actual assignment; do not
send a local guide path as though the worker can open it. For example:

```text
Use [actual inputs] to complete [outcome] in [format/destination]. Perform the
applicable analysis, creation/editing, checks and corrections with your available
authorized tools before returning the result, not instructions for me to finish it.
No Git/CI setup is needed unless this outcome requires it. Preserve [constraints].
If one step is blocked, finish independent work and identify that specific gap,
the evidence and smallest remaining action. Do not add unrequested external actions.
```

These are behavior-evaluation cases, **not claims that a model has been tested**:

| Case | Expected result | Failure to avoid |
| --- | --- | --- |
| Plain folder, edit granted, no `.git` | Direct supported-file changes and appropriate checks | Requiring GitHub setup or handing a patch to the parent |
| Uploaded data; analysis and export available | Calculated/checked final data artifact with real delivery | Returning a Python script instead of the requested workbook |
| Requested document and rendering available | Finished document with relevant content/layout checks | Stopping at an outline or asking the parent to format it |
| Connected spreadsheet edit, write approved | Actual scoped edit and supported readback | Describing clicks for the parent or changing sharing settings |
| Review-only or draft-only request | Complete review/draft without modifying or sending originals | Treating the absence of more restrictions as universal permission |
| One unavailable export or local placement | Completed independent content/checks plus an exact blocked remainder | Abandoning the whole task or reporting delivery as complete |

For an actual trial, use an authorized real task, record parent interventions and
rework with their reasons alongside acceptance, and mark unavailable trials NOT_RUN.
Do not run every case before routine work. Static documentation/CI checks cannot
establish adoption, model behavior or measured resource savings. Reuse the existing
[parent acceptance record](parent-acceptance.md); no new dashboard or second ledger.

Capability references (checked 2026-09-29): OpenAI's [data analysis guide](https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt),
[file uploads FAQ](https://help.openai.com/en/articles/8555545-file-uploads-faq) and
[plugins/apps guide](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex)
illustrate non-repository work and account-dependent capabilities. They do not prove
that any particular worker session has a tool, access or permission. Inspect the
actual session and respect its controls instead of hard-coding product limits here.

## Guidance delivered by the running bridge

The worker's `initialize.instructions` carries a compact version of this policy;
`submit_result` also describes feasible-work completion and its terminal, text-only
boundary. This reaches the connection/tool surface instead of relying solely on a
parent-local guide. MCP's [initialization lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
provides this advisory field; clients decide how it is presented to the model.
It is not execution authority or proof of model compliance.

The task's instructions, inputs, destination and restrictions still come from the
actual assignment. The bridge does not append guidance to `get_task`, rewrite saved
instructions, expose other tasks, grant separate-app access or add a binary channel.
Its lack of shell/Git is a bridge limitation, not a ban on separately authorized
worker tools. Parent acceptance and fresh collection checks remain required.

Updating only Markdown cannot change an already running server or cached client
metadata. Apply matching code using the existing [stopped-update procedure](operations-windows.md#parent-resume-transition-and-rollback),
then check the selected connection's current initialization/tool guidance through
its supported refresh/reconnection route when needed. Do not recreate connections,
restart services or repeat these checks on every healthy task. Existing chats may
retain older guidance; local HTTP/CI tests do not establish live client adoption or
parent-work savings. No task-state or tool-argument migration is introduced.
