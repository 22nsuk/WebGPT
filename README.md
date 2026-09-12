# WebGPT

A Codex skill that delegates work to your signed-in ChatGPT.

Split work into short, parallel chats. Codex saves and verifies results, then deletes the task chats. The ChatGPT tab stays open.

## Install

Paste this into Codex:

```text
Install the webgpt skill from https://github.com/Nhahan/WebGPT,
using the skill at skills/webgpt. Preserve any existing installation
and ask before replacing it. Check that you can control a signed-in
ChatGPT browser session. For direct coding, set up the bundled local
workspace worker and its private connection; verify actual file edits.
```

## Use

Tell Codex:

```text
webgpt xh Review this project and find bugs.
```

```text
webgpt p Research this topic and summarize the findings.
```

`xh` = Extra High · `p` = Pro. Add your request after either prefix.

Requires Codex browser control and a signed-in ChatGPT session. Direct coding uses the included workspace worker or an existing local-project connector.

[MIT license](LICENSE)
