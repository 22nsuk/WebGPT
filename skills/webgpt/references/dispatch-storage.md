# Parent dispatch storage failures

Use with [dispatch.md](dispatch.md). The existing private per-task ledger remains
canonical. No new task state, controller protocol or browser transport is introduced.

## Reads and creation

Ledger, CLI payload and lock reads validate the named file and opened descriptor,
reject links or changed file identity, and read at most 2 MiB plus one overflow
sentinel byte. Overflow is an error, never a truncated JSON value. Exact-limit
files remain valid. Strict UTF-8 parsing and bounded public errors are unchanged.
This limits bytes per read, not total memory, execution time or every local race.

Locks and temporary ledger files are created exclusively with mode 0600, written
through the owned descriptor, flushed and closed before successful publication.
Known existing entries, including dangling links, are rejected before creation is
attempted; exclusive creation also rejects a file appearing after that check.
After the native flush and close, the creator checks that the pathname still
names the same regular single-link file with the expected byte length. Opened
and final device/inode observations use BigInt without rounding. A mismatch is
`DISPATCH_CONFLICT` at `lock_acquire` or `ledger_write`; native metadata failures
retain `DISPATCH_STORAGE` and the same stage. A failed lock check never marks
ownership acquired or authorizes cleanup; a failed candidate check never reaches
rename or the next browser callback. Both candidates remain inspection evidence.
No BigInt is saved in the ledger or returned in compact summaries.

These are two metadata observations per successful exclusive creation, not a
new content reread or another begin publication. They do not isolate an in-place
same-inode/same-size edit, a replacement after the final observation, a competing
writer of the destination, or lock changes later in the browser callback. The
existing cooperative/private-directory assumptions and no-resend workflow remain.

Windows privacy still depends on the existing directory ACLs. No ACL is modified.

## One publication for each requested transition

`beginDispatch`, CLI `begin` and the text-only adapter share one begin operation.
It validates fresh readiness, then writes `before`, `preparedAt`, `sendingAt` and
`sending` together in one flushed replacement. It does not first publish a
redundant `prepared` snapshot under the same lock. Explicit `prepareDispatch` or
CLI `prepare` still saves an independently inspectable `prepared` checkpoint;
begin rechecks readiness rather than trusting that earlier observation.

This removes one ledger reread, serialization, stage creation/write/flush/close
and replacement per begin. It does not remove the lock, the pre-publication
comparison or the mandatory flush before any send-capable action. The high-level
adapter keeps its lock across browser callbacks; split callers keep the existing
successful-begin rule. There is no new state, option, helper module or migration.

## Failed files remain evidence

A failed create does not establish ownership of an existing path. A partial write,
flush failure or failed rename leaves the temporary file for private inspection;
it is no longer unconditionally deleted by a cleanup handler. An unconfirmed lock
write also leaves its lock and blocks another parent, as before. No age-based lock
stealing, stage promotion, file deletion or browser replay is performed.

Only the committed ledger's state authorizes the next operation. A failed
explicit `prepared` or begin's `sending` publication happens before the send callback.
If replacement has not happened, the original `registered` or explicitly saved
`prepared` ledger remains byte-identical; a leftover candidate is not authority.
If replacement succeeded but its caller saw an error, committed `sending` still
blocks another begin. No automatic retry is added in either case. A failed
confirmation after a send leaves committed `sending`/`uncertain` blocking resends;
a candidate containing `submitted` is not confirmation authority. Re-observe the
owned chat and controller and use the existing confirmation/recovery procedure.
A generic retry must never reconstruct transmission history from leftover filenames.

Preserve the ledger, lock and relevant `<ledger>.tmp-<id>` files before an authorized
offline inspection. They can contain private ledger fields. Do not print their
contents or raw errors in general output. Failed candidates may accumulate; there
is no directory-wide storage quota or automatic pruning. Any later removal requires
a deliberate disposition of the evidence, not simply a successful new invocation.

The JSON schema and normal compact summaries are unchanged. The obsolete
`temporary_cleanup` diagnostic stage is no longer emitted; write/flush/rename
failures retain the existing bounded `ledger_write`/`ledger_publish` categories.
This is cooperative filesystem safety, not exactly-once delivery, an OS sandbox
or a power-loss transaction spanning the browser and disk.

Run `node --test --test-reporter=tap scripts/dispatch.test.mjs scripts/dispatchStorage.test.mjs`
from the installed skill, and the complete repository suite before deployment.
The fixtures test failed creation, partial writes, flush/close/rename barriers,
post-publication errors, single-begin publication, input growth, exact-limit reads
and lock/descriptor cleanup. The existing storage fault matrix also swaps real
same-size candidates after flush/close at preparation, sending and confirmation.
It requires refusal before the relevant send, retained committed barriers after
sending, and preservation of the flushed and substituted files. Creator-specific
cases cover lock/candidate swaps, added hardlinks, size changes, large identities
and metadata failure cleanup; common-reader tests retain their separate ownership.
These fixtures use no live browser or
production data. Native Windows/macOS and live connector behavior require their
own validation; local Linux results are not evidence of those checks.
