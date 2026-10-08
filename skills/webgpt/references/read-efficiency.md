# Read costs without weakening recovery

## Original-backup inspection

Every recovery inspection still checks the actual bytes of every referenced
original. This includes the checks before later edits/deletes, successful
completion, startup recovery and conditional collection. A saved hash, a prior
successful inspection, or unchanged file size/mtime is not proof that the backup
still exists and remains intact. No cross-request integrity cache was added.

`inspectRecovery()` now hashes and validates originals incrementally through
`scanBoundedFile()`, rather than using a whole-file text snapshot. The scanner
shares the checked descriptor boundary and chunk loop with `readBoundedFile()`:
initial absence only, full-width device/inode comparison, regular single-link
files, nonblocking/no-follow open where supported, opened-file checks, a 10 MiB
allowance plus one overflow sentinel, and closure on success or failure.
Journals retain their separate 1 MiB allowance and existing receipt validation.

Each original is consumed in chunks no larger than 64 KiB. The UTF-8 decoder
carries split sequences between chunks and checks its final state; embedded NUL,
invalid UTF-8 and a mismatched SHA remain failures. Raw bytes, including BOMs,
are hashed. Neither a whole-backup `Buffer.concat` nor a whole-backup string is
needed. The synchronous consumer must not retain chunks or publish a verdict
before the scan succeeds.

**This reduces transient materialization, not valid-backup I/O volume or the
number of integrity scans.** It is not an atomic snapshot against external
writers or a deadline for an unresponsive filesystem. No backup format, journal,
state schema, recovery quarantine or collection condition changes.

## One-copy read responses

`read_file` and `read_input` advertise an optional `responseFormat` argument:

- Omitted or `"dual"`: the existing JSON text in `content[0].text` **and** the
  same object in `structuredContent`.
- `"text"`: the same complete JSON text in `content[0].text`, with no
  `structuredContent` duplicate. `isError` remains `false` on success.

For example, after confirming that `tools/list` advertises this argument:

```json
{
  "token": "YOUR_PRIVATE_TASK_TOKEN",
  "path": "src/example.mjs",
  "responseFormat": "text"
}
```

This is still serialized JSON, not raw file text or a summary. Parse
`result.content[0].text` after checking `result.isError`. Consumers supporting
both formats can use `result.structuredContent ?? JSON.parse(result.content[0].text)`
on successful responses. No body moves into hidden metadata or a separate resource.

The option is per call and works with full reads and existing line windows.
It does not opt a full read into a default window. File existence, exact text,
whole-file SHA, mode and window metadata remain unchanged; full `read_input`
retains its existing `{name,text}` shape. Prefer bounded windows when only an
excerpt is needed, and keep whole-file SHA pins across subsequent file windows.
Error envelopes, authorization, task lifecycle and the seven-tool surface remain
unchanged. Other tools reject `responseFormat` as an unexpected argument.

The existing default remains dual for compatibility with consumers using either
field. The worker does not infer text-only support from a protocol version,
User-Agent or an earlier call. Older workers reject the new argument; refresh
tool discovery after updating the installation and do not assume that a live
connector has already updated.

The MCP 2025-06-18 tools specification recommends a serialized TextContent copy
when structured results are returned. Text mode instead returns an ordinary
text-only tool result; it does not return structured data without that copy.
These read tools do not declare a structured output schema.
See <https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content>.

## Reproducible checks

```sh
node --test skills/webgpt/scripts/boundedFile.test.mjs skills/webgpt/scripts/recoveryScan.test.mjs skills/webgpt/scripts/readResponse.test.mjs
node tests/run.mjs
```

The new tests observe native file reads, closure and whole-body materialization,
exercise split/invalid UTF-8, growth, identity changes and same-size corruption,
and compare actual loopback MCP responses in both supported protocol versions.
They also retain later-edit, completion and collection recovery gates. The POSIX
FIFO probe runs in a disposable child with an external deadline; a timeout fails.
Fixture byte counts are reproducible cost evidence, not a latency benchmark,
a heap/RSS measurement, a model-token estimate or browser/installed-service
acceptance. Real clients must consume TextContent before opting in.
