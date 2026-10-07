# File-read ownership and limits

The regular-file opening and bounded materializing read contract lives in `scripts/bounded-read.mjs`, not
in separate file-open loops in runtime, workspace, result, audit and dispatch
adapters. Committed state reuses that opening mechanism without a byte quota. This is an implementation boundary; it adds no parent workflow step,
MCP tool, permission, stored format, migration or automatic recovery action.

## Shared mechanism, domain-owned policy

`readBoundedFile(file, limit, invalid)` validates the explicit byte allowance,
checks the named file with `lstat`, opens it read-only with `O_NOFOLLOW` and
`O_NONBLOCK` where available, and rechecks the opened regular single-link file
and its device/inode. Nonblocking open prevents a path replaced by a FIFO after
`lstat` from waiting for a writer before `fstat` can reject its type. It does not
make a FIFO an accepted input or turn regular-file I/O into asynchronous work.
It reads at most `limit + 1` bytes through `readBytesUpTo`, rejects overflow before
returning a prefix, and closes its descriptor on success or failure. It returns
`{ bytes, stat }`, where `stat` is the opening `BigIntStats` observation, or
`null` only for an initial `ENOENT`. Errors after observing the file are not converted to absence.

`readUnboundedFile(file, invalid)` is the explicit committed-state path. It uses
the same initial/type/link/identity validation and descriptor cleanup, but reads
all bytes with `readFileSync(fd)` from that checked descriptor, not by reopening
the path. It does not apply the marker, result or offline-diagnostic allowance.
The public bounded API still rejects omitted, null, infinite or invalid limits;
only the private shared implementation uses a null limit for the uncapped path.
Both wrappers return the same `{ bytes, stat }` or initial-absence result.

The optional fourth argument `{ allowLinks: true }` is reserved for callers whose
input contract follows links, currently common configuration. It uses `stat`
and a following open, permits hard links, and compares the observed target's
full-width identity to the opened regular file. Size, sentinel and descriptor
cleanup checks are unchanged. Omitting the option keeps the strict single-link
policy; committed-state reads do not opt in.

Both named and opened metadata use `bigint: true`: distinct 64-bit device/inode
values can alias after conversion to `Number`. Keep identity comparisons exact;
do not reject legitimate large identities merely because they exceed the safe
integer range. Workspace snapshots convert only their masked permission bits
back to the existing numeric `mode` field. No BigInt enters wire data or state.
These checks cover this shared reader family; it does not migrate
persisted workspace-root identifiers or every other filesystem identity check.

The rejection factory returns the domain error for `metadata`, `identity` or
`overflow`. Native I/O errors propagate; adapters retain their existing public
classification boundaries. In particular, owner lookup I/O retains its native
error boundary, while failure to read/decode a discovered owner remains
`LOCK_UNCERTAIN`. No failed owner read is proof of death or permission to release
or replace a lock. Caller authorization, privacy checks, decoding, SHA checks,
collection policy and evidence disposition do not move into the byte reader.

| Adapter / data | Read allowance | Policy retained by the adapter |
| --- | --- | --- |
| Common configuration | 64 KiB | User-selected regular target, existing symlink/hardlink compatibility, strict UTF-8/JSON with one leading BOM, explicit overrides and initial-absence defaults |
| Parent controller key | 4096 bytes | Same strict file policy and byte allowance as worker startup; unchanged UTF-8 decoding, no key creation/rotation or trimming |
| Runtime committed state | No new fixed quota | Existing task parsing, initialization evidence and pre-publication byte comparison; the adapter returns only bytes, never BigInt metadata |
| Runtime initialization marker | 28 bytes | Exact existing marker; absence differs from corrupt state |
| Runtime worker/service lock owner | 4096 bytes | Lock directory, owner identity, host/PID and uncertain ownership |
| Result and interrupted-result candidates | 1 MiB | Task-derived paths, full SHA, terminal status, UTF-8 for display |
| Workspace files and original backups | 10 MiB | Grant/path/Git boundaries, UTF-8 without NUL, full SHA, original-byte verification |
| Mutation journals | 1 MiB | Strict UTF-8/JSON, operation/path/hash binding and receipt validation |
| Diagnostic byte adapter | Caller-selected | Existing audit 1 MiB, offline state 32 MiB and marker/service discovery 4096-byte allowances; each consumer's parse/privacy policy |
| Dispatch ledger, CLI payload and release-time lock read | 2 MiB | Ledger ownership, input-specific errors, conditional publication and no-resend evidence |

A file replaced between the initial observation and open is rejected even if the
replacement has identical bytes. An initially oversized workspace file now also
fails before content open, rather than only at the opened-file check. This is
not an atomic snapshot: an in-place writer can still change bytes or append
within the allowance during the read. In particular, the diagnostic reader must
not treat the original file size as a frozen log length. Domain hashes and late
mutation/collection guards are still required.

## Configuration and parent key reads

The configuration allowance covers stored UTF-8 bytes, including a BOM and JSON
whitespace. 64 KiB leaves room for the small settings object and long paths,
without materializing arbitrarily padded input. Larger configurations are now
rejected, not truncated. Task JSON supplied to the client CLI keeps its existing
input contract and does not inherit this configuration quota.

Only an initial missing configuration target may select defaults for the implicit
path. An explicitly selected missing target still fails. Because configuration
retains link-following compatibility, an initially dangling config symlink has
that same absence behavior. An `ENOENT` after observing a target is instead
propagated, never converted to defaults. The parent key retains the strict
single-link policy: even an initially dangling key symlink is invalid, and a
missing key is `ENOENT`, never permission for the client to create one.

Metadata, identity or allowance failures use `CONFIG_INVALID`. Native open/read
errors keep their original codes; JSON/UTF-8 and settings validation keep their
existing diagnostics. Key decoding is unchanged and header-compatible non-UUID
keys are not normalized. Refusals occur before HTTP and do not authorize retries,
key rotation or file repair. HTTP timeouts cannot interrupt synchronous reads;
these byte/type checks are not a general deadline for a stalled filesystem.

## Workspace path text

The shared workspace relative-path validator requires well-formed Unicode before
lookup, parent creation, mutation or recovery receipt acceptance. An unpaired
UTF-16 surrogate must not be encoded as U+FFFD and silently address a different
native filename. Reject it with the existing path diagnostic; do not normalize,
repair or echo the supplied spelling. Genuine U+FFFD names, supplementary Unicode
characters and ordinary non-ASCII paths remain allowed.

This input check does not replace the native UTF-8 round-trip checks: those reject
non-UTF-8 native names reached through aliases or returned by directory listing.
The two checks protect opposite sides of the encoding boundary. SHA checks still
pin file contents, not the identity of a malformed path string.

An old applied journal with an ill-formed path is unresolved recovery evidence,
not an accepted receipt. Preserve the journal and original backup for the existing
manual recovery review; do not rewrite its path, replay a mutation or discard it.
There is no automatic state migration or change to valid receipt formats.

## Recovery inspection traversal

`inspectRecovery` keeps the shared-parent and task-directory checks, then lets
`snapshot` own each journal/backup file's named and opened metadata validation.
It does not perform another, weaker `lstat` before that same read. Every accepted
receipt still requires valid JSON, operation/filename binding, path/action/hash
fields and the actual original backup bytes. Missing, invalid or unreadable
files still produce the journal's unresolved diagnostic, not a partial receipt.

An inspection-local insertion-ordered Set handles unresolved-path membership.
A failed final journal suppresses its corresponding staged diagnostic; a valid
final journal does not hide a remaining stage, and an orphan stage stays visible.
The public result remains ordered arrays. Stages are not read, promoted, replayed
or deleted. This removes accumulated array scans, not directory sorting or full
file reads/hashing; it is neither an integrity cache nor a total latency bound.
Worker receipt matching and independent startup/readiness/collection decisions
remain separate and continue to revalidate their own observations.

## Deliberately different paths

- A state publication retry already owns a read/write descriptor. It keeps that
  descriptor for the mandatory flush and compares only the expected candidate
  length plus one sentinel with `readBytesUpTo`; it does not reopen the path.
  Result retry flushing likewise keeps its existing caller-owned descriptor and
  1 MiB-plus-sentinel comparison. The file-opening helper does not own either
  publication operation, its permissions, cleanup or recovery evidence.
  The state writer uses `BigIntStats` for the candidate's named/opened/final
  observations: an existing candidate must still be the same device/inode at
  open before retry bytes are read or flushed. After flush and descriptor close,
  both new and retried candidates must still match that exact identity and size
  before rename. A replacement is `STATE_STAGING_CONFLICT`; committed bytes and
  remaining candidates are preserved. Equal large identities are valid, and no
  BigInt is persisted or returned. These are observations, not an atomic path
  binding: in-place changes and replacement after the final check remain outside
  this guarantee. Audit writers and persisted workspace IDs are separate.
- Result publication owns one read/write descriptor for new candidates and
  explicit retries. It retains the shared reader's opening `BigIntStats` for a
  retry, compares exact device/inode before reading or flushing, and checks the
  current path's regular-file type, single link, full-width identity and expected
  size after flush and close. Only then may a temporary candidate be renamed or
  an existing final candidate yield a receipt. Identity/content changes use
  `RESULT_CONFLICT`; invalid metadata remains `RESULT_INVALID`, and native I/O
  failures propagate. Candidates are preserved, not deleted or automatically
  replayed. Metadata stays internal; result receipts and pending-result reports
  keep their existing shapes. This is not an atomic filesystem transaction:
  same-inode in-place changes, replacement after the final observation, and
  external destination races remain outside the cooperative runtime-lock model.
  Later result verification and guarded collection are still required.
- `readStateBytes` continues to read the variable-sized committed task inventory
  through the shared checked descriptor without a newly imposed fixed quota.
  A late different-file or hardlink replacement is `STATE_INVALID`; a late
  native open/read error is not converted to an absent or empty inventory.
  This is not a persistent inode pin across separate calls: normal worker state
  publication replaces the file. State staging is bounded by the explicit
  candidate length, not a new inventory limit. Arbitrarily applying the marker,
  result or offline diagnostic allowance would reject valid retained tasks.
- The parent-only artifact scanner remains streaming: it hashes a source up to
  256 MiB while retaining only selected windows and enforcing initial-size plus
  sentinel and post-read checks. Routing it through a materializing helper would
  retain unnecessary source bytes and lose its stronger source-change checks.
- User-selected task JSON retains its existing path and decoding contract,
  separate from the configuration allowance and private-key policy above. This
  is not a claim that every repository read or total runtime resource use is bounded.

`O_NOFOLLOW` is not available on every supported platform. The named-file checks
remain necessary, but neither those checks nor an inode comparison create an OS
sandbox or prevent every hostile ancestor/path race. A byte ceiling is not a
read timeout, a power-loss guarantee, or a total-process memory/latency bound.

## Regression ownership

Keep one owner per assertion family, not one copy per historical fix:

| Test owner | Responsibility |
| --- | --- |
| `boundedFile.test.mjs` | Shared file-opening mechanism: opaque bytes, absence/empty input, full-width identity, metadata, FIFO substitution without a writer for bounded and committed-state reads, native failures and descriptor closure; the I/O observer's hook timing, accounting and scoped restoration |
| `configurationReads.test.mjs` | Real common-configuration and parent-request adapters: limits, link-policy distinction, initial versus late absence, preserved decoding/errors/evidence, FIFO child watchdogs and a real CLI/loopback exchange with larger task JSON |
| `fileReadContract.test.mjs` | Real adapter matrix: short reads, growth/oversize rejection, error classification and identity swaps; candidate-length state retries |
| `recoveryInspection.test.mjs` | Recovery traversal work budgets, complete receipt sets, ordered/suppressed staged diagnostics, fresh backup checks and per-record failure isolation with preserved sibling receipts/evidence |
| `runtimeMetadata.test.mjs` | Marker format/absence, metadata path types, uncapped committed state, late state replacements, descriptor-bound reads and error cleanup, and worker/service ownership lifecycle |
| `boundedReads.test.mjs` | Descriptor primitive and mutation/recovery/real HTTP consequences, including the second-open result retry-flush race |
| `resultPublication.test.mjs` | Result publication: exact retry/open and pre-publication identities, flush/close ordering, preserved candidates, and real MCP refusal without completion or token retirement |
| `stateStorage.test.mjs` | State publication: private exclusive creation, exact retry/open and pre-rename identities, byte comparison, mandatory flush, descriptor closure, preserved conflicting evidence and controller/retirement consequences |
| `workspace.test.mjs` | Workspace CRUD, path encoding, read-only mutation refusal and preserved bytes/revisions, retained receipt paths and actual MCP consequences |

Workspace MCP cases reuse `test-fixtures/worker-http.mjs` for transport, not for
policy assertions. The read-only deletion regression lives with the existing
workspace permission case, including matching-SHA rejection and unchanged content
and revision; it does not need a second fixture or standalone test file.

The marker/owner matrix retains their exact 28/4096-byte short-read boundaries,
zero ownership probes on rejection, and recovery-guard cleanup. These checks
replace the eight overlapping metadata size/growth/short-read/error cases; they
are not removed coverage. Type/link and lifecycle assertions remain domain-owned.

These suites reuse `test-fixtures/file-read.mjs` for native I/O
observation. Its `afterStat` hook runs after the actual descriptor observation;
`beforeRead` runs once before content reading. Injection writes and unrelated
files do not count as reader I/O. Retry-flush tests select their second stat and
subtract earlier verification bytes rather than changing the byte ceiling.
Restore only observer-owned mocks before inspecting evidence. Specialized
primitive read/shrink/append fault injection remains in its owning tests.

A test that layers its own native fault mock over the observer owns both layers.
Its final cleanup must first `t.mock.reset()` to disassociate those tracked mocks,
then restore the fault mock and observer in reverse order. The observer's restore
also synchronizes builtin ESM bindings. Manual `mock.restore()` alone leaves the
mocks tracked: Node's later automatic reset can reinstall an observer after the
test's assertions have passed. Do not put a whole-context reset in the shared
observer, which must leave caller-owned mocks alone. The mechanism suite checks
original descriptors and ESM bindings again after the serial fault tests finish.

The FIFO mechanism regression uses the existing `beforeOpen` observer hook and
an actual POSIX `mkfifo` fixture in a disposable child. Its existing harness runs
for the bounded reader and the actual `readStateBytes` adapter, rather than
copying FIFO setup or a second child program. It verifies both rejection
of an already-known FIFO before open and refusal of a later replacement before
content reads, with descriptor closure and original/replacement preservation.
Its hard child deadline bounds a broken test; timeout is failure, not successful
refusal. Windows skips only these POSIX-specific cases; ordinary-file and
adapter contracts remain covered by their existing cross-platform suites.

Add a bounded materializing adapter to the matrix instead of copying a file-open
spy or the same scenario into a second suite. Retain worker/collection/recovery
assertions: a common-reader refusal alone does not establish no mutation,
no acknowledgment or token retention. Do not remove installed-layout or
cross-platform execution merely because it runs the same test sources.

References: [Node filesystem flags and reads](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html),
[Node builtin ESM binding synchronization](https://nodejs.org/download/release/v22.16.0/docs/api/module.html#modulesyncbuiltinesmexports),
[Node mock lifecycle](https://nodejs.org/download/release/v22.16.0/docs/api/test.html#mockreset).
