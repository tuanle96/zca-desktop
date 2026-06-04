---
name: debug-flow
description: Use this skill whenever the user reports a bug, unexpected output, or "this doesn't work". Runs the dev server, drives the failing flow via Playwright MCP if installed (else captures stdout/stderr), and produces a minimal repro before any fix. Mirrors the OpenAI Chrome-DevTools-Protocol-into-runtime pattern at solo scale — verify the failure before you propose a fix.
allowed-tools: Read, Bash(npm run dev), Bash(curl:*), Bash(playwright:*), Bash(.harness/scripts/dev-up.sh)
suggested-turns: 20
---

## Steps

1. **Start the dev server** via `.harness/scripts/dev-up.sh`. Wait for the readiness
   probe.
2. **Drive the failing flow.**
   - If the bug is UI: use Playwright MCP (`mcp__playwright__*`) — the
     Anthropic claude.ai-clone pattern.
   - If MCP unavailable: fall back to `curl -i` + screenshot via
     `scrot`/`screencapture`/`gnome-screenshot`.
3. **Capture context.** Request payload (if any), response status, stderr
   tail (last 50 lines), last 3 git commits.
4. **Write a minimal repro** to `.harness/repros/<date>-<slug>.md` with:
   environment, steps, expected, actual.
5. **Only then propose a fix.** Run the structural test and the relevant
   smoke test after the fix. Re-run the repro to confirm.

## Output contract

```
### Repro saved: .harness/repros/<filename>
### Failure mode: <one-line summary>
### Smallest failing input: <code or curl command>
### Proposed fix location: <file:line>
```

## Anti-patterns

- Don't propose a fix before reproducing the bug locally.
- Don't fix more than the user reported in the same commit.
- Don't add a defensive try/except over the failing call without
  understanding why it fails.
