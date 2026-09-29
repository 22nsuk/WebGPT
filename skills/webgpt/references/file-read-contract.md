# File-read ownership and limits

The bounded materializing read contract lives in `scripts/bounded-read.mjs`, not
in separate file-open loops in runtime, workspace, result, audit and dispatch
adapters. This is an implementation boundary; it adds no parent workflow step,
MCP tool, permission, stored format, migration or automatic recovery action.

## Shared mechanism, domain-owned policy

`readBoundedFile(file, limit, invalid)` validates the explicit byte allowance,
checks the named file with `lstat`, opens it read-only with `O_NOFOLLOW` where
available, and rechecks the opened regular single-link file and its device/inode.
It reads at most `limit + 1` bytes through `readBytesUpTo`, rejects overflow before
returning a prefix, and closes its descriptor on success or failure. It returns
`{ bytes, stat }`, where `stat` is the opening observation, or `null` only for an
initial `ENOENT`. Errors after observing the file are not converted to absence.

The rejection factory returns the domain error for `metadata`, `identity` or
`overflow`. Native I/O errors propagate; adapters retain their existing public
classification boundaries. In particular, owner lookup I/O retains its native
error boundary, while failure to read/decode a discovered owner remains
`LOCK_UNCERTAIN`. No failed owner read is proof of death or permission to release
or replace a lock. Caller authorization, privacy checks, decoding, SHA checks,
collection policy and evidence disposition do not move into the byte reader.

| Adapter / data | Read allowance | Policy retained by the adapter |
| --- | --- | --- |
| Runtime initialization marker | 28 bytes | Exact existing marker; absence differs from corrupt state |
| Runtime worker/service lock owner | 4096 bytes | Lock directory, owner identity, host/PID and uncertain ownership |
| Result and interrupted-result candidates | 1 MiB | Task-derived paths, full SHA, terminal status, UTF-8 for display |
| Workspace files, journals and original backups | 1 MiB | Grant/path/Git boundaries, UTF-8 without NUL, full SHA, receipt validation |
| Diagnostic byte adapter | Caller-selected | Existing audit 1 MiB, offline state 32 MiB and marker/service discovery 4096-byte allowances; each consumer's parse/privacy policy |
| Dispatch ledger, CLI payload and release-time lock read | 2 MiB | Ledger ownership, input-specific errors, conditional publication and no-resend evidence |

A file replaced between the initial observation and open is rejected even if the
replacement has identical bytes. An initially oversized workspace file now also
fails before content open, rather than only at the opened-file check. This is
not an atomic snapshot: an in-place writer can still change bytes or append
within the allowance during the read. In particular, the diagnostic reader must
not treat the original file size as a frozen log length. Domain hashes and late
mutation/collection guards are still required.

## Deliberately different paths

- A state publication retry already owns a read/write descriptor. It keeps that
  descriptor for the mandatory flush and compares only the expected candidate
  length plus one sentinel with `readBytesUpTo`; it does not reopen the path.
  Result retry flushing likewise keeps its existing caller-owned descriptor and
  1 MiB-plus-sentinel comparison. The file-opening helper does not own either
  publication operation, its permissions, cleanup or recovery evidence.
- `readStateBytes` continues to read the variable-sized committed task inventory
  without a newly imposed fixed quota. State staging is bounded by the explicit
  candidate length, not a new inventory limit. Arbitrarily applying the marker,
  result or offline diagnostic allowance would reject valid retained tasks.
- The parent-only artifact scanner remains streaming: it hashes a source up to
  256 MiB while retaining only selected windows and enforcing initial-size plus
  sentinel and post-read checks. Routing it through a materializing helper would
  retain unnecessary source bytes and lose its stronger source-change checks.
- User-selected configuration/JSON input and private key loading are not silently
  converted to the single-link bounded-file policy. Their existing path, decoding
  and compatibility contracts remain separate; this change is not a claim that
  every repository read or total runtime resource use is now bounded.

`O_NOFOLLOW` is not available on every supported platform. The named-file checks
remain necessary, but neither those checks nor an inode comparison create an OS
sandbox or prevent every hostile ancestor/path race. A byte ceiling is not a
read timeout, a power-loss guarantee, or a total-process memory/latency bound.

## Regression ownership

`boundedFile.test.mjs` exercises the common mechanism, including short reads,
opaque bytes, empty/absent files, pre-open rejection, opened metadata, native
errors and descriptor closure. `fileReadContract.test.mjs` runs the same contract
matrix through the real domain adapters and checks candidate-length state retry
comparison. Its native I/O observer is in `test-fixtures/file-read.mjs`, so moving
between a whole-file and descriptor read cannot silently bypass instrumentation.
Add a new bounded materializing adapter to this matrix instead of copying its
own file-open/read loop. Keep existing worker/collection/recovery tests as the
integration check; common reader tests do not replace lifecycle assertions.

References: [Node filesystem flags and reads](https://nodejs.org/download/release/v22.16.0/docs/api/fs.html),
[Node builtin ESM binding synchronization](https://nodejs.org/download/release/v22.16.0/docs/api/module.html#modulesyncbuiltinesmexports).
