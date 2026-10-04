# Startup key files

`worker.start()` reads its persisted keys with the existing `readBoundedFile`
primitive before opening either HTTP listener. This is startup robustness for
misplaced or damaged private runtime files, not a claim of a remote exploit.

| File | Stored-byte allowance | Existing format within that allowance |
| --- | --- | --- |
| `controller.key` | 4096 bytes | Nonempty HTTP `authorization: Bearer …` header value; no trailing space or tab. Not restricted to UUIDs. |
| `mcp-path.key` | 64 bytes | Exactly 64 lowercase hexadecimal characters, without a newline; read only when `publicMcp` is enabled. |

The controller allowance is a byte limit, not a character count. It leaves room
for custom header-compatible keys as well as the generated UUID. The former
unlimited length is intentionally no longer accepted. Existing decoding and
header validation are retained; no trimming, normalization or format migration
is performed. The public route's 64-byte allowance matches its generated format.

## Read and failure contract

The shared reader rejects non-regular files, symlinks and files with more than
one hard link before reading their contents. It rejects a size already over the
allowance before opening the file, verifies the opened descriptor's device and
inode against the initial path observation, and uses a bounded read with one
overflow-sentinel byte to detect growth. Its existing nonblocking open also
protects against a regular path being swapped for a FIFO during open.

Only an `ENOENT` from the initial path inspection means a key may be created.
Creation retains exclusive `wx` semantics and mode `0600`; a file that appears
in the meantime is not overwritten. A dangling symlink is not absence. Errors
after the initial inspection, including a later `ENOENT`, are propagated rather
than treated as permission to regenerate a key.

Invalid metadata, identity, size or key text produces `CONFIG_INVALID`.
Filesystem failures such as `EACCES` or `EIO` retain their original error code.
Startup releases its runtime lock and does not open either listener on these
failures. Existing key files and state evidence are not repaired, truncated,
deleted or rotated automatically. Normal creation of an initially missing key
can precede a failure on another startup input; startup is not transactional.

Preserve a rejected file and inspect its type, size, ownership and source before
an operator repairs it. Do not delete keys as a generic retry step, print key
contents in diagnostics, or automatically rewrite a public connector URL.

The descriptor check is not an atomic snapshot against same-inode external
writers, and the byte allowance is not a general I/O deadline for stalled
filesystems. No filesystem isolation or wall-clock guarantee is added here.

## Regression evidence

Run the focused integration and shared-reader tests from the repository root:

```sh
node --test skills/webgpt/scripts/startupKeys.test.mjs skills/webgpt/scripts/startup.test.mjs skills/webgpt/scripts/publicMcp.test.mjs skills/webgpt/scripts/boundedFile.test.mjs
```

The new startup tests call the real `start()`, not an extracted read expression.
Writerless FIFO cases run in a separate Node process with an external watchdog
because an in-process timeout cannot interrupt synchronous file I/O. Those two
cases are POSIX-only; other metadata, size, growth, identity, I/O-failure,
restart and authenticated custom-key cases also run on Windows. File symlink
cases explicitly skip when the Windows account cannot create native symlinks.
The existing test runner includes this file in both repository and standalone
skill-copy suites; no new CI job or test framework is needed.

CI verifies the tested checkout, not an operator's installed worker. A deployment
record must separately identify the installed SHA, compatibility conditions,
CI result and real installation acceptance evidence. These tests neither deploy
nor restart an operational service.
