# WebGPT

A Codex skill that delegates work to your signed-in ChatGPT.

Split work into short, parallel chats. Codex saves and verifies results, then deletes the task chats. The ChatGPT tab stays open.

## Install

Paste this into Codex:

```text
Install https://github.com/Nhahan/WebGPT/tree/main/skills/webgpt
and follow its references/setup.md to finish setup and verify it.
```

Requires Codex browser control and ChatGPT access to the requested mode. Direct coding and
completion notifications additionally require Node.js 22+, ChatGPT developer mode and an eligible
Platform organization/workspace with Secure MCP Tunnel access. Without that connection, only
text-based tasks are available. Codex follows [the setup guide](skills/webgpt/references/setup.md);
sign-in and account permissions may require your action.

## Use

Tell Codex:

```text
webgpt xh Review this project and find bugs.
```

```text
webgpt p Research this topic and summarize the findings.
```

`xh` = Extra High · `p` = Pro. Add your request after either prefix.

[MIT license](LICENSE)
