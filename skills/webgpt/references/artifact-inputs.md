# Large and binary artifacts without expanding worker authority

Use this optional parent-side route only when the ordinary project text API or
small native test report is insufficient. It is not another normal-task preflight.
Keep direct project editing for supported source files; do not export a repository
that the worker can already read. The [development loop](development-loop.md),
[attachment delivery](file-uploads.md) and [fork policy](fork-policy.md) still apply.

## Decision and tradeoffs

The original artifact-route review used fork main `48b8447baf925ebe8fe621bcaa11f0f7f017a8a5`
and upstream `Nhahan/WebGPT` main `1d35588e79de288bd8a6d2992fc76e571f7bb75e` on 2026-09-28.
Upstream's `skills/webgpt/scripts/terminal.mjs` explicitly treats cwd as a convenience,
passes the worker environment to a shell, and has no command timeout/output truncation.
That provides real native-tool autonomy, but not the fork's project-file boundary.
The current choices below also reflect the subsequent expansion to 10 MiB workspace text files.

| Approach | Benefit | Cost / decision |
| --- | --- | --- |
| Raise the workspace text limit from 1 MiB to 10 MiB | Larger direct text edits with the existing SHA and backup checks | Selected for workspace text and original backups. Increases whole-file I/O, response and memory costs; journals/results stay at 1 MiB. Adds no binary semantics or native execution. |
| Add binary/chunk upload and mutation APIs | Transport arbitrary bytes | Requires new authorization, assembly, conflict, cancellation and recovery contracts; base64 is not semantic inspection. Not selected. |
| Add a shell or command-name allowlist | Run native tools in one worker session | A permitted interpreter, test, build hook or converter can execute project code with host privileges. Neither cwd nor an allowlist is isolation. Not selected. |
| Parent prepares bounded, fingerprinted evidence | Analyze large/binary inputs and CLI output using existing named inputs | Parent retains execution/conversion and mutation. Selected: useful read-only capability without a new remote endpoint, queue or state machine. |

The two routes are complementary: the worker owns useful analysis and supported
source changes; the parent owns host-only native execution and mutations outside
the workspace text boundary. This reduces manual excerpt assembly and repeated scans
for several selected windows.
It does **not** make the worker equivalent to an autonomous terminal agent or establish
measured latency/token/quality gains. Direct execution would need a separately
reviewed OS-isolated mode, not reinterpretation of existing `read`/`edit` grants.

## Prepare one evidence record

The installed `scripts/artifact-input.mjs` uses Node.js 22+ built-ins only. The
parent explicitly selects an authorized, stable local source and a new output file
in a private directory it owns. Prefer a closed log or preserved artifact over a
file still being written. Paths are absolute; the label is a shareable alias, not
a path. Source/output strings must be well-formed Unicode: an unpaired surrogate
is rejected before filesystem access rather than silently selecting or creating a
different replacement-character filename. Deliberate `�`, paired emoji and ordinary
Unicode paths are preserved; no normalization is applied. This does not recover
path bytes already replaced by an embedding caller. The default is **metadata only**:
size and whole-source SHA-256, no content.

```text
node <skill>/scripts/artifact-input.mjs --source <absolute-artifact> --label build-log --out <new-private-json>
```

For a large log, select one or more zero-based **byte** ranges, not line numbers or
UTF-16 character offsets. The second number is a length, not an end offset. This
example captures 2 KiB near each of two parent-identified locations in one scan:

```text
node <skill>/scripts/artifact-input.mjs --source <absolute-log> --label build-log --view text --range 0:2048 --range 1048576:2048 --out <new-private-json>
```

For an explicitly requested binary header:

```text
node <skill>/scripts/artifact-input.mjs --source <absolute-binary> --label asset-header --view hex --range 0:128 --out <new-private-json>
```

These argument forms work in POSIX shells and PowerShell; replace placeholders and
quote paths containing spaces. The helper writes UTF-8 itself, so no shell-dependent
text redirection is needed. It creates `--out` exclusively and refuses existing
files, including the source; it never overwrites, appends, uploads or deletes them.
A failed output write can leave partial evidence: preserve and inspect it; do not
register it as success or automatically retry/remove it. On success stdout contains
`ok`, the output byte count and SHA-256 of the **evidence file**, not its contents.
Do not pipe that receipt into registration as though it were the evidence.

Before opening the output, the CLI rejects any existing leaf (including a dangling
symlink) and treats metadata lookup failures as errors, not absence. Exclusive
creation remains mandatory because this check cannot reserve the path. The newly
opened descriptor must be an empty regular single-link file. After writing,
flushing and closing it, the CLI checks that the output path still names that file,
with its expected byte count and unchanged mode/link count, before emitting a receipt.
A missing, replaced, newly hard-linked or truncated output yields `OUTPUT_CHANGED`
with no success receipt; partial output and other writers' files remain untouched.
Write timestamps are not compared across close because Windows may finalize them
only then. These are identity/size observations, not atomic publication or protection
against every same-inode content race. Use an owned stable output directory and
recheck the saved bytes against the receipt before later sharing or registration.

The CLI can run from a symlinked installation, including with Node
[`--preserve-symlinks-main`](https://nodejs.org/api/cli.html#--preserve-symlinks-main)
(with or without `--preserve-symlinks`). It remains built-in-only so a preserved
leaf symlink does not need sibling modules beside the link. Entry detection uses
Node's `import.meta.main === true` as a fast path; otherwise it excludes eval/print
arguments and separately loaded query/fragment URLs before resolving both paths.
A preload of the main URL can be cached with native main identity still false.
An execution marker on Node's shared `process` object records a CLI attempt or
failed entry lookup, without requiring an extensible global object, ensuring that
canonical and preserved-symlink URLs run the CLI once per process, including failures.
Importing the API does not inspect a CLI source or create an output,
even when eval arguments name this script. Call `buildArtifactInput` explicitly
for a read-only API operation; do not set `process.argv` and import as a CLI launcher.
Use the actual CLI entry to create an evidence file. This is about the installed
script, not source-file permission: linked sources remain rejected. Fallback
permission/I/O lookup failures produce a nonzero, path-redacted diagnostic when
the entry spelling or a successful lookup identifies this module as the entry
candidate. An unrelated import whose entry cannot be resolved stays quiet;
native main detection needs no such lookup. Exit zero
alone is not an evidence receipt.

Every invocation hashes the whole source once using a 64 KiB read buffer and
retains only selected bytes. Sources over **256 MiB** reject before opening; actual
reads stop at the initially observed size plus one sentinel, even during growth.
There are at most **eight nonoverlapping ranges**, **8 KiB combined requested
bytes**, and **64 KiB serialized output**. No silent resizing or base64 file dump.
The byte/I/O budget is not a wall-clock timeout for a slow filesystem.

The evidence record distinguishes:

- `source.label`, `source.sizeBytes`, `source.sha256`: the selected source's identity.
- `windows`: sorted byte offsets, requested/returned lengths, exclusive ends,
  per-window hashes, exact content and explicit EOF clipping; `omittedBytes` counts
  all source bytes not included in these nonoverlapping windows.
- `view` and `textValidation`: strict UTF-8 validation applies only to returned text
  windows, **not** to the entire source or a binary format's structure.

A text window containing NUL, malformed UTF-8 or a split multibyte character rejects;
align its byte boundaries or explicitly choose hex. BOM, CRLF and Unicode are
preserved, not replaced/normalized. A range beyond EOF rejects; a range reaching
past EOF reports the shorter actual length. An empty source/window is not PASS.
Hex is raw-byte evidence, not an image rendering, archive listing or parser result.

For later windows from the same source, add
`--expected-sha256 <previous-source.sha256>`. A changed whole source rejects even
when the requested window is unchanged. Do not replace a conflicting expected hash
just to continue the old analysis: inspect the new revision and reframe it explicitly.
Each invocation still scans the source; combine known windows rather than repeatedly
hashing it. There is no persistent cache or snapshot session.

## Review, then use the existing task input route

Inspect the evidence for relevance and private data before sharing. The helper does
not copy the source path, command line, environment or native error message into its
output. Nevertheless labels, hashes and selected contents can be sensitive; this is
**not automatic redaction**. Supply the reviewed evidence file's **text** as a named
string in the ordinary registration payload's `inputs`. For example, in the parent's
existing Node payload-building code (with trusted absolute paths already selected):

```js
const evidenceText = fs.readFileSync(evidencePath, 'utf8');
// After inspecting it, add to the existing payload; do not invent/reuse task authority.
payload.inputs = { ...payload.inputs, artifactEvidence: evidenceText };
```

The worker uses `read_input(token, "artifactEvidence")` without range arguments for
this bounded record. The JSON can contain a single long line; default ranged reads
may reject it. No workspace grant is needed to read a supplied input. A parent-local
path by itself is not an input and must not be presented as remotely readable.
The evidence-file/`read_input` digest covers the serialized record; `source.sha256`
and window hashes cover their respective original bytes. They are different hashes.
The existing task's aggregate registration/transport limits still apply.

## Native work and derived evidence

For CLI-heavy work, review executable inputs and batch the relevant **authorized**
checks/conversions in the parent's existing execution environment. Preserve their
real command, revision, tool version, exit code/signal and full private output as
specified in [development-loop.md](development-loop.md). Feed an existing small
native report directly; use this helper for selected portions of a larger saved
report/log. It does not execute commands, parse process status or infer success
from a hash, an empty log or the CLI helper's own `ok` receipt. Keep the Node failure
reporter for Node tests instead of replacing it with generic log excerpts.

For a binary requiring semantic inspection, the parent uses an authorized native
parser/converter, or the existing attachment route when the model needs the actual
visual/binary input. Preserve the original source hash plus the derived report's
hash and the actual conversion command/version/status. Bind the conversion to an
unchanged source (prefer an immutable input copy); hashing a live source later does
not prove which bytes the converter consumed. A derived report is not the original
file, and matching local hashes do not prove remote attachment bytes/parsing.
Required visual/attachment evidence cannot be silently substituted with a header
or text summary. Browser readiness and same-message attachment confirmation remain.

Writes of text over 10 MiB, binary mutation, conversion, builds and tests stay
parent/native operations for this host-only route.
There is no request broker, poller, automatic command execution, command allowlist,
retry-until-green or terminal/PTY dependency. Keep source/output roots and pre-existing
changes safe, inspect the proposed operation and retain ordinary backups; artifact
input evidence supplies no write permission or multi-file rollback. Sources beyond
256 MiB remain parent/native work: return a reviewed native summary with explicit
provenance/limits rather than claim that this helper inspected them.

## Security and installation boundary

The helper is **not imported by the worker or controller**. Its parent-side local
path selection is not restricted by a worker workspace grant and does not change
that grant. Only the authorized parent invokes it; do not expose it through MCP or
execute worker-supplied paths/commands automatically. Leaf symlinks, hard links and
nonregular sources reject; descriptor/path identity, size and modification metadata
are checked before/after reading. These checks detect ordinary concurrent changes,
not every adversarial race. Trusted path ancestors and a cooperative filesystem are
assumptions, not OS-enforced isolation. Keep secrets out of shared evidence; on
Windows select a directory with appropriate ACLs (POSIX mode 0600 is not a Windows
ACL). No lock, runtime configuration, worker state or recovery record is changed.

Install the matching skill files through the existing idle/stopped-worker update
procedure; do not overwrite an active installation. No new dependency, connector
schema refresh or stored-task migration is required **for this helper**. It does not
change the 10 MiB UTF-8 workspace limit, 1 MiB saved-result limit, path/Git protections,
SHA conflict checks, backup/journals, result review before collection or chat retention.
Unit and CI coverage are not proof of a live Windows/WSL/browser/connector deployment.
