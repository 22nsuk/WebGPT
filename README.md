# WebGPT

A Codex skill that delegates work to your signed-in ChatGPT.

Split work into short, parallel chats. Keep detailed results in files. Let Codex verify and combine them, then delete the task chats with your permission.

## Install

Paste this into Codex:

```text
Install the webgpt skill from https://github.com/Nhahan/WebGPT,
using the skill at skills/webgpt. Preserve any existing installation
and ask before replacing it. Check that you can control a signed-in
ChatGPT browser session; tell me if setup is needed.
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

Requires Codex browser control and a signed-in ChatGPT session.

[MIT license](LICENSE)
