# Selective upstream and fork review — 2026-09-23

## Revisions and scope

| Repository | Reviewed main commit |
| --- | --- |
| 22nsuk/WebGPT (integration base) | `2cbe872d950c79b3fc1c94ed6a4e516328a97a7b` |
| Nhahan/WebGPT (upstream) | `1d35588e79de288bd8a6d2992fc76e571f7bb75e` |
| bizstoa1/WebGPT | `1d35588e79de288bd8a6d2992fc76e571f7bb75e` |
| captainsoldier/WebGPT | `87bb032283e7137cd5d5fdc12389ae7e57b0cbbe` |

GitHub main refs and trees establish that bizstoa1 and upstream are identical at these
revisions, not two independent sets of fixes. Captain's comparison against upstream
has merge base `a2a4c4f15b62813cc87700b15b34480146775b04`, two unique commits and ten
upstream-only commits. Its two PR patches were inspected in full. This review targets
main branches; unmerged branches and private deployment settings are not included.

The comparison read the upstream skill, complete browser helper, client orchestration,
worker audit/transport implementation, complete diagnostic/tunnel helpers and the
accountless-restart validation report. These were compared against this fork's current
controller, state/result/workspace recovery and policy contracts. This is a selective
integration assessment, not an exhaustive audit of every upstream bundled dependency
or proof that its browser UI assumptions hold in the user's installation.

## Adopted

| Change | Source and adaptation |
| --- | --- |
| Exact `/health` GET/HEAD and 405 handling | [captainsoldier PR #2](https://github.com/captainsoldier/WebGPT/pull/2). Add HEAD without weakening Origin checks, capability routing or private readiness authentication. Liveness still is not readiness. |
| Opt-in, bounded metadata-only HTTP/MCP observations | [upstream worker](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/skills/webgpt/scripts/worker.mjs). Adapt to the existing seven file tools and generated transport IDs, with strict record allowlists, safe-file checks, two capped segments and nonfatal capture failures. No new MCP action or task state. |
| Offline task-scoped diagnostic report | [upstream diagnose](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/skills/webgpt/scripts/diagnose.mjs). Reuse this fork's persisted-state/result validators, enforce actual read caps, bound output and exclude other tasks. Do not treat file existence, an HTTP finish or missing logs as completion/platform proof. |

This is a new implementation adapted to the file-worker contracts, not a wholesale
merge or copy of upstream persistence/terminal code. Capture is disabled unless the
parent's launch environment explicitly enables it. See [diagnostics.md](diagnostics.md).
The existing task ledger, review-before-ack, result preservation and backup schedule
are unchanged. The integration adds no external package or public telemetry service.

## Retained or deferred

| Candidate | Decision and reason |
| --- | --- |
| Browser dispatch/mode/startup helpers | Defer wholesale import. The [helper](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/skills/webgpt/scripts/browser.mjs) has useful scoped observations, caller-provided documented CUA controls and bounded UI checks. Its attempt registry is in-memory, however, and permission/deletion defaults and returned URL/tab fields differ from this fork. Replacing the durable dispatch ledger would regress restart ambiguity handling. No live browser test was performed here. |
| `finish` / `resume` convenience commands | Do not import the [client](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/skills/webgpt/scripts/client.mjs) verbatim. `finishTasks` acknowledges while collecting before returning; this fork explicitly keeps parent review/disposition before acknowledgment and supports interrupted collection. Quiet scoped waits and byte verification already exist. |
| Registration connection metadata | Useful future convenience, not connectivity proof. Upstream `connectionMetadata` returns local setup selection hints. This fork must not call those hints readiness or change its existing registration response contract incidentally. |
| Managed accountless tunnel and origin guard | Defer deployment integration. [tunnel.mjs](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/skills/webgpt/scripts/tunnel.mjs) distinguishes observed origin from the verified connector and stops on mismatch. Importing it requires reconciling existing Windows service ownership/configuration. No tunnel was installed, started, replaced or republished. |
| Terminal / PTY / `webgpt open` | Exclude: full OS-user command execution is not equivalent to project read/edit grants. Keep revision checks, protected Git paths, original backups and the seven file-worker tools. |
| `partial` terminal status | Do not add a state/schema migration for this integration. Existing failed/cancelled results can preserve partial deliverables; a dedicated status would require all lifecycle validators/clients to change together. |
| Forced English coordination, Always allow, default permanent deletion | Exclude conflicting defaults from the [upstream skill](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/skills/webgpt/SKILL.md). Preserve user-language work, actual permission gates and retained chats. |
| Autonomous writer and squash-merge policy | Do not adopt [captainsoldier PR #1](https://github.com/captainsoldier/WebGPT/pull/1). A workflow-specific AGENTS file is not general authorization to merge, broaden file grants or operate an unavailable writer app. |
| Upstream state, result and lock implementations | Retain this fork's stronger staged-state, revision, backup and shutdown recovery controls, including merged PR #11. Do not undo them while importing observability. |
| CI changes | Retain the current SHA-pinned actions, Dependabot, read-only permissions and Windows/macOS/Ubuntu × Node 22/24/26 matrix. No new action, install hook or workflow privilege. |

## Evidence limits and integration validation

Upstream's [accountless-restart report](https://github.com/Nhahan/WebGPT/blob/1d35588e79de288bd8a6d2992fc76e571f7bb75e/validation/2026-09-23-accountless-restart.md)
reports two real Quick Tunnel starts and explicitly excludes browser/connector repair.
Those are the upstream author's reported checks, not tests executed by this review.
No token, latency or reliability improvement percentage is inferred from them.

This integration's tests run with disposable directories and local loopback traffic;
source Git blob hashes were checked before execution. The local environment is Linux
with Node 22.16.0. The full existing repository suite, Windows/macOS and live ChatGPT,
tunnel and installed service workflows require separate validation. Exact local test
counts and hosted CI observations are recorded in the integration PR, not inferred
from upstream test counts. No main-branch merge or production deployment is included.
