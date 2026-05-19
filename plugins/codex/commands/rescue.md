---
description: Delegate investigation, an explicit fix request, or follow-up rescue work directly to Codex
argument-hint: "[--background|--wait] [--no-monitor] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [what Codex should investigate, solve, or continue]"
context: fork
allowed-tools: mcp__shell__run, Bash(node:*)
---

Run Codex directly through the companion helper.

Raw user request:
$ARGUMENTS

Execution rules:

- Do not invoke the Skill tool, Task tool, Agent tool, `codex:rescue` skill, or `codex:codex-rescue` agent.
- Make exactly one `mcp__shell__run` call to execute `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...`.
- Use `Bash(node:*)` only as a fallback if `mcp__shell__run` is unavailable.
- Return the companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after the companion stdout.
- If the user did not supply a request, ask what Codex should investigate or fix.

Argument routing:

- Strip `--wait`; it only means run the helper in the foreground.
- Preserve `--background` by passing `--background` to the helper.
- Preserve `--no-monitor` by passing `--no-monitor` to the helper.
- Preserve `--model <value>` and `--effort <value>` by passing them to the helper.
- Map `--model spark` to `--model gpt-5.3-codex-spark`.
- Convert `--resume` to `--resume-last`.
- Preserve `--resume-last` if it is already present.
- Preserve `--fresh` if it is present.
- If neither resume nor fresh is present, add `--fresh` for a predictable one-shot handoff.
- Add `--write` unless the user explicitly asks for read-only behavior.
- Preserve the remaining user text as the Codex prompt, apart from stripping routing flags.

Examples:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --fresh "ping pong test - just respond with pong"
```

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --write --background --fresh "investigate the failing test and fix it"
```
