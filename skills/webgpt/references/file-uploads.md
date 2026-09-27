# File uploads: browser capability, source path and attachment evidence

Use this guide when a delegated task needs ChatGPT web attachments or an upload fails.
It is a parent/browser workflow, not an uploader implementation or a new worker capability.
For direct repository work, keep the existing [workspace grant](workspace.md); uploading an
archive does not replace required project access. Conversely, `read_file`, `read_input` and
controller registration do not create attachments in ChatGPT's composer.

## Identify the actual route before changing settings

Record the active browser tool, owning application/version, extension ID/version and Chrome
profile privately. A product name or an enabled setting in another profile is insufficient.
For OpenAI's desktop browser extension, check Settings > Computer Use and select the connected
Chrome browser for the task. Follow the controls actually exposed by the installed host; do not
invent an upload method from another product's documentation.

| Selected route | What must be established |
| --- | --- |
| Desktop task using the Chrome extension (`@Chrome`) | Correct connected profile, file-URL permission, and an available documented file-upload action. |
| Desktop built-in browser (`@Browser`) | OpenAI currently documents that automated file uploads are unsupported here; the Chrome toggle cannot enable them. |
| Cloud/remote browser | Its machine is separate from the user's computer. A local pathname alone does not transfer a file to it. |
| WebGPT MCP file/input tools | Scoped project text or supplied task inputs, not browser upload transport. |

These product distinctions follow the [extension](https://learn.chatgpt.com/docs/chrome-extension)
and [browser](https://learn.chatgpt.com/docs/browser) guides, checked **2026-09-27**. Recheck current
support when the host/version changes. Do not infer which route failed without observing it.

For the Chrome extension, `Allow access to file URLs` controls that extension's `file://` access;
Chrome exposes the read-only `chrome.extension.isAllowedFileSchemeAccess()` query in the extension
context, not an ordinary web page. See the [Chrome API](https://developer.chrome.com/docs/extensions/reference/api/extension#method-isAllowedFileSchemeAccess).
OpenAI instructs starting the Chrome task again after changing this setting. If it is already on,
check the active profile/connection and a fresh **diagnostic** task rather than repeatedly toggling it.
Missing upload capability is a blocker, not permission to use private APIs, inject a file-input path,
copy cookies, enable full CDP access or broaden all-site permissions. Follow mandatory approvals.

A new browser diagnostic is not a new registration or retransmission of existing work. Preserve
`sending`, `uncertain` and `submitted` records and the owned chat; use [dispatch recovery](dispatch.md#interruption-and-reconciliation)
first when the original send might have happened. Do not restart apps holding active work as the
first upload test. Later connection repair follows the official guide and existing user authority.

## Verify the file on the machine that must read it

Use the upload action's documented argument type: a host pathname, file URL or supported file
handle are not interchangeable. A Windows file may be `C:\Users\<user>\Downloads\probe.txt`
while its WSL spelling is `/mnt/c/Users/<user>/Downloads/probe.txt`. Do not pass the latter as a
Windows pathname. Windows can expose WSL files through `\\wsl$`, but that does not establish
that a particular upload bridge supports that path. See [Microsoft's filesystem guide](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

A cloud `sandbox:/mnt/data/...` reference is not a file on the user's Windows computer.
Changing slashes or prepending `file://` does not transfer bytes. Use only a supported, authorized
transfer to an explicit host location when necessary, then verify that copy; preserve the original.
Do not move an entire project, change file permissions or disable protections to test one upload.

Through authorized local tools, check the exact source's existence, readable bytes, filename and
size on the reading host. A local digest can identify the intended copy; it is not proof of remote
upload. Keep paths and digests private. For Windows, these read-only checks accept a literal path:

```powershell
Get-Item -LiteralPath 'C:\Users\<user>\Downloads\probe.txt' | Select-Object Name, Length
Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Users\<user>\Downloads\probe.txt'
```

## Bound the whole attachment attempt with existing dispatch state

Before beginning, keep the required file list and expected identities in the original private task
record's allowed-input/work fields, alongside its objective and owned target. Create that record before
dispatch registration through the existing parent workflow; do not add fields inside strict `dispatch`,
edit a ledger while a helper owns its lock, or create a competing completion store. Missing requirements
on resume are missing evidence, not permission to assume a text-only task.

Use the **split Node CLI** for required attachments, not high-level `dispatchPrompt`, which automatically
confirms only the body. Capture current mode/connector/composer/predecessor evidence, then run
`client.mjs dispatch begin` **before the first upload-capable browser action**. Its exclusive ledger lock
publishes `sending` and rejects competing begins. Only the caller whose begin succeeded may continue
that uninterrupted attempt. A blocked/failed begin authorizes neither upload nor message send.

After begin, use the documented upload control once per required file and observe each ready in the
exact owned composer, with no progress/error indicator. Respect any exposed processing state. A selected
filename, closed chooser, clickable Send button, local hash or successful tool return alone is insufficient.
If upload fails or readiness is unavailable, preserve the attempt with `dispatch recover`; do not fill or
send a source-dependent prompt, repeat the upload, or reset the ledger to make the command pass.

Once every required file is ready, perform the existing batched body fill/send, with no upload work or
fixed sleep between them. If the target/draft changed after begin, stop and inspect rather than adopting
a new target or refreshing the saved baseline. After sending, inspect the body **and** attachments on the
same new user message, matching required count and exposed identifiers/names. Only after both checks
pass may the parent call CLI `confirm` with the unchanged strict body observation. Keep required-file
identity and narrow attachment evidence private in the existing task record; UI acceptance does not
prove remote byte/hash identity, complete parsing or that the model used all content.

If the parent stops after upload, after send, or before attachment inspection, the persisted state is
still `sending`/`uncertain`. A resumed parent must inspect the original requirements, owned composer/
message and controller, never call upload or begin again automatically. Preserve valid body evidence
while withholding confirm when attachment evidence is missing or ambiguous. The same original attempt
can be confirmed later after actual evidence is recovered. If a prior revision already recorded body-only
`submitted`, retain it but independently check required attachments before accepting the work; do not
reset it. Controller completion/collection cannot substitute for this parent review.

The helper does not itself inspect files or enforce this procedure on arbitrary callers. The ordering
conservatively uses the existing `sending` state even when upload has begun but no body was sent;
recorded confirmation intervals therefore include upload/review time. A confirmed non-submission
requiring a new attempt remains an explicit operator decision under [dispatch recovery](dispatch.md#interruption-and-reconciliation),
not an automatic retry. Preserve partial results and their honest disposition instead of labeling
attachment-dependent work verified merely to clear a pending check.

## Isolate a failure with one harmless comparison

Use a tiny, uniquely named UTF-8 `.txt` containing a nonsecret marker in a confirmed Windows-local
folder. In an authorized diagnostic chat with the same account/profile/destination, compare manual
attachment through the page chooser with the documented Chrome tool action. Stop at attachment
readiness unless a diagnostic message is also authorized; attaching already transfers the file.
Do not reuse the production prompt, register replacement work or include task tokens in the probe.
Record each attempted upload once; stop on a reproducible error instead of looping retries.

| Observation | Next distinction, not an established cause |
| --- | --- |
| Tool has no upload action, or rejects before file selection | Check actual backend, profile, connection and task capability/approval. Do not diagnose a network upload from this alone. |
| Same file works manually but not through the Chrome tool | Focus on the automation path, host pathname and fresh task. General file/account acceptance worked in the control, but this does not identify an extension bug. |
| Small Windows-local probe works; original or WSL-path file fails | Compare file type/size, path accessibility, source host and exact error; do not infer that all WSL paths or Unicode names are unsupported. |
| Manual and automated attachment both fail | Inspect the page's error, upload network request, account/file restrictions and current service status before blaming the extension. |
| Attachment becomes ready but is absent from the sent message | Inspect the owned draft/message transition and send ordering; preserve original dispatch evidence and do not resend automatically. |

For ChatGPT destinations, check current [file limits](https://help.openai.com/en/articles/8555545-file-uploads-faq)
rather than hardcoding plan quotas; failed attempts can count toward upload limits. A successful
text conversation does not test the upload path. OpenAI's [network guide](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps)
identifies `*.oaiusercontent.com` for relevant upload failures. Review the actual failed hostname
and browser/HTTP error with the network administrator; do not disable VPN/security tools or allow
all domains by default. A service-wide [status page](https://status.openai.com/) is not account-level
proof or evidence about an earlier failure.

When direct browser evidence is unavailable, mark the live diagnosis **NOT_RUN / cause unconfirmed**.
Collect only application/browser/extension versions, selected tool/profile, timestamp/timezone,
source host/path class, file type/size, failure stage, exact sanitized error and manual-control outcome.
Keep full paths, chat/request IDs and diagnostic captures private; use official support for necessary
sensitive details. Do not publish cookies, headers, signed upload URLs, raw HAR files, file contents,
controller keys, task tokens or unrelated tabs. If a user-only chooser/approval is needed, request
that specific action rather than claiming unsupported automation or silently changing input delivery.
