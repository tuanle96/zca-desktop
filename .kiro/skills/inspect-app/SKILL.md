---
name: inspect-app
description: Use this skill whenever the user asks to "test the UI", "check what the app looks like", "inspect the page", "verify the dev server is up", or before claiming a UI feature is done. Boots the dev server via .harness/scripts/dev-up.sh and drives the failing flow through Playwright MCP if installed (else falls back to curl + lightweight HTML capture). Mirrors the OpenAI Chrome-DevTools-Protocol-into-runtime pattern at solo scale — verify the running app, don't trust the type checker alone.
allowed-tools: Read, Bash(.harness/scripts/dev-up.sh), Bash(curl:*), Bash(playwright:*)
suggested-turns: 12
---

## When to use

The user said any of: "what does the page look like", "test the UI flow",
"is the dev server up", "before merging the UI work", or invoked this skill
explicitly via `/inspect-app`. Also auto-invokes from `/debug-flow` when the
bug is UI-shaped.

## Steps

1. **Detect dev server.** Read `.harness/config.json` for the framework.
   - If a process is already listening on the expected port (3000 / 8000 /
     5000 depending on framework), reuse it.
   - Else: `bash .harness/scripts/dev-up.sh &` in the background and wait up to 30s
     for the readiness probe.
2. **Capture mode — Playwright MCP (preferred).** If `mcp__playwright__*`
   tools are available:
   - `mcp__playwright__browser_navigate` to the target URL
   - `mcp__playwright__browser_snapshot` for accessibility tree
   - `mcp__playwright__browser_take_screenshot` for a visual
   - Optionally drive a single user flow (click → fill → click → wait)
3. **Capture mode — curl fallback.** If MCP is unavailable:
   - `curl -i -s -o response.body "http://localhost:$PORT$PATH"` for headers + body
   - `wc -l response.body` to size-check
   - `grep -E '<title>|<h1>' response.body | head -5` for sanity
4. **Diff against expectation.** If the user gave an expected element /
   text, grep for it. If not, just report what's on the page.
5. **Cleanup.** Kill the dev server we started (don't kill ones already
   running before this session).

## Output contract

```
### App inspection
**URL:** http://localhost:<port><path>
**Status:** <HTTP status>
**Title:** <page title or first H1>
**Mode:** playwright-mcp | curl-fallback
**Screenshot:** <path or "n/a">
**Findings:** <bulleted list of matches/mismatches against expectation>
```

## Anti-patterns

- Don't claim a UI feature is done without running this skill once.
- Don't leave a dev server running after the inspection — kill what you
  started.
- Don't grep for "Error" alone as a failure signal — many pages legitimately
  contain that word. Match against specific expected text instead.
- Don't take screenshots of pages with secrets or test fixtures with PII —
  the screenshot lands on disk.
