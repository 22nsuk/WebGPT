# WebGPT

A Codex skill that delegates work to your signed-in ChatGPT.

Split work into short, parallel chats. Codex saves and verifies results, deletes the task chats, then closes their task tabs. Other tabs stay untouched.

## Install

Paste this into Codex:

```text
Install https://github.com/Nhahan/WebGPT/tree/main/skills/webgpt
Follow references/setup.md to configure browser control, the local Worker,
and the ChatGPT WebGPT Worker plugin through a private MCP tunnel.
Ask me for sign-in, local credential entry or required setup approvals
only until installation is complete. Handle everything else yourself.
Verify direct file edits, completion notifications and chat/tab cleanup
before declaring success. Save and reuse the setup without asking me
to configure it again during normal use.
```

Full setup requires Codex browser control, the requested ChatGPT mode, Node.js 22+,
ChatGPT developer mode and Secure MCP Tunnel access. Without the private connection,
only text-based tasks are available. [Setup details](skills/webgpt/references/setup.md).

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
