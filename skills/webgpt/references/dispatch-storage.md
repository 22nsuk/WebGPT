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
Windows privacy still depends on the existing directory ACLs. No ACL is modified.

## Failed files remain evidence

A failed create does not establish ownership of an existing path. A partial write,
flush failure or failed rename leaves the temporary file for private inspection;
it is no longer unconditionally deleted by a cleanup handler. An unconfirmed lock
write also leaves its lock and blocks another parent, as before. No age-based lock
stealing, stage promotion, file deletion or browser replay is performed.

Only the committed ledger's state authorizes the next operation. A failed
`prepared` or `sending` publication happens before the send callback. A failed
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
The fixtures test failed creation, partial writes, flush/rename barriers, input
growth, exact-limit reads and lock/descriptor cleanup with no live browser or
production data. Native Windows/macOS and live connector behavior require their
own validation; local Linux results are not evidence of those checks.
