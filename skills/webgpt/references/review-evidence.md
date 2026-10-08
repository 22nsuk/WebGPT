# Record result review separately from final chat observation

Use this optional parent helper after inspecting a saved result export and the
owned chat. It records bounded evidence in the existing private task ledger.
It does not operate a browser, call the controller, collect a task or authorize
tab closure. Keep the ordinary collection/recovery workflow independent.

## Record and inspect

```text
node <skill>/scripts/client.mjs dispatch record-review <absolute-ledger.json> <absolute-observation.json>
node <skill>/scripts/client.mjs dispatch inspect-review <absolute-ledger.json>
```

The ledger must already have a confirmed `submitted` dispatch. The supplied task
ID, actual chat URL and `replyToUserMessageId` must match its confirmation. A new
tab's initial URL may be null; the confirmed URL is used. Do not manufacture or
reset dispatch state to make this helper pass. An uncertain dispatch with a
terminal controller result still follows existing collection/recovery rules.

Create the observation privately from actual parent review and authorized chat
observations. The following example deliberately records a completed generation
whose text is still truncated, so overall review remains incomplete:

```json
{
  "taskId": "owned-task-id",
  "observationId": "review-observation-1",
  "observedAt": "2026-10-08T10:00:00.000Z",
  "result": {
    "directory": "/absolute/private/export",
    "expectedSha256": "<64 lowercase hex characters from the original review>",
    "coverage": "full",
    "disposition": "accepted",
    "evidenceRef": "private-result-review-record"
  },
  "chat": {
    "url": "https://chatgpt.com/c/owned-chat",
    "replyToUserMessageId": "confirmed-user-message-id",
    "turnId": "observed-turn-id",
    "generation": "completed",
    "evidenceRef": "private-chat-observation-record",
    "message": {
      "id": "observed-final-assistant-message-id",
      "role": "assistant",
      "text": "The actual observed answer prefix...",
      "truncated": true,
      "substantive": true
    }
  },
  "comparison": {
    "status": "not_compared",
    "differencesDisposition": "not_applicable",
    "evidenceRef": "private-comparison-pending-record"
  }
}
```

Use a real absolute path appropriate to the reading host, real identity values
and a stable observation ID/time. Never pass raw answers, tokens or private
references in shell arguments. The CLI input file is subject to the existing
2 MiB private-file limit. Unknown fields fail; page pagination fields such as
`hasMore` or `nextCursor` are not substitutes for message truncation evidence.

The helper invokes `readSavedResult` once, rechecking the complete export against
the original task/SHA pins. It records verified byte integrity and total text
length, but **coverage and disposition remain parent reports**. Reading a file
does not prove reviewing it. Result coverage is `not_read`, `partial` or `full`;
disposition is `pending`, `accepted`, `rejected` or `partial`. Acceptance requires
full reported coverage; an unread result can only have pending disposition.

Chat generation is `unobserved`, `pending`, `completed` or `interrupted`. An
unobserved chat uses `turnId: null` and `message: null`; otherwise preserve the
actual observed turn/message identity. A completed generation still needs an
identified, substantive, untruncated assistant answer to finish content review.
Missing truncation flags are invalid, never silently false. `substantive` is a
parent judgment, not a length heuristic or a claim based only on a stopped UI.
The observation supports one final assistant message of at most 65,536 UTF-16
units. For a longer or multi-message final answer, keep the limitation explicit
and use existing manual bookkeeping with separately retained evidence rather
than falsely setting `truncated: false` or combining invented message identities.

`observedTextSha256` and `observedChars` describe the exact supplied text, including
a truncated prefix. They do not become the full answer hash. Raw text and export
paths are omitted from the stored receipt; preserve the source under its private
`evidenceRef`. References are bounded labels/pointers, not files automatically
opened or independently authenticated by the helper. Chat observations are
caller-reported; no browser observation is invented by this command.

Comparison is `not_compared`, `consistent` or `differences`. Differences must
have disposition `pending` or `resolved`; other states use `not_applicable`.
Record the actual comparison and resolution in the private evidence reference.
A prefix may reveal differences, but cannot establish whole-answer consistency
or resolution. Consistency/resolution requires full report coverage, completed
generation and a substantive untruncated answer. Unknown or contradictory
combinations fail without changing prior records.

## Meaning and preservation

Compact output includes `reportedReviewComplete`, separate result disposition,
chat generation/content coverage, comparison and fixed `attention` codes. A fully
reviewed **rejected** result can have `reportedReviewComplete: true`; that means
the review is finished, not that the task succeeded or its output was accepted.
`observationSource: caller_reported`, `liveTaskChecked: false`,
`browserChecked: false` and `authorizesClosure: false` remain explicit.
Inspect returns `review: null` when no observation exists; absence is not success.
Inspect summarizes retained evidence without rechecking the export or live chat.

Receipts append under the top-level `reviewEvidence` array in the same private
ledger, using its existing dispatch lock/publication safeguards. Dispatch fields
and other task data remain unchanged. No parallel authoritative review ledger is
created. Every record and retry verifies the current export. The same observation
ID and identical receipt is a no-write retry; different evidence under that ID
fails. New observations use new IDs and nondecreasing observation times. A later
incomplete observation stays incomplete; replaying an old complete observation
does not replace the latest summary. Original task/result/chat/request pins stay
fixed for this history. This is an observation history, not a worker-attempt or
token-consumption counter.

The history is limited to 128 entries and the existing 2 MiB ledger limit. An
overflow, damaged retained history, ownership mismatch or storage failure
preserves prior evidence and fails; there is no automatic pruning, lock stealing,
resend or unbounded fallback. Keep the ledger and payload private. Existing
[dispatch storage](dispatch-storage.md) assumptions and recovery limits apply.

For manual workflows without confirmed dispatch metadata, import the read-only
`buildReviewEvidence(spec)` and `reviewEvidenceSummary(receipt)` functions from
`scripts/review-evidence.mjs`, then retain the receipt through existing parent
bookkeeping. The builder verifies the export and returns a receipt but writes no
file. The API does not independently bind a manual chat to a dispatch; the parent
must establish that association. Do not fabricate confirmed dispatch evidence.
The recorded helper APIs are `recordDispatchReview` and `inspectDispatchReview`
from `scripts/dispatch.mjs`.
