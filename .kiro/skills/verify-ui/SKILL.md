---
name: verify-ui
description: Run Browser Validation with Playwright golden-path checks, screenshots, console/network capture, and HTML reporting.
allowed-tools: Bash(node .harness/scripts/verify-ui.mjs:*)
suggested-turns: 6
---

# Verify UI

Runs Tier 4 Browser Validation for a project UI.

## Commands

```bash
node .harness/scripts/verify-ui.mjs --url=http://localhost:3000
node .harness/scripts/verify-ui.mjs --command="npm run dev" --url=http://localhost:3000
node .harness/scripts/verify-ui.mjs --mock --allow-mock-exit-zero
```

`--mock` is only a report-generation smoke mode. It is not browser evidence and
must not be used to satisfy a task evidence `ui` gate.

## What it checks

- Page loads successfully.
- Golden-path screenshot is captured.
- Console errors are collected and fail the run.
- Failed requests and HTTP 4xx/5xx responses are collected and fail the run.
- Artifacts are written under `.harness/ui-validation/<run-id>/`.

## Output

- `summary.json` — machine-readable pass/fail and artifacts.
- `report.html` — browser validation dashboard.
- `screenshots/home.png` — full-page screenshot when Playwright runs.
- `.harness/ui-validation/latest.json` — pointer to the latest result.

Task evidence that references `summary.json` requires passing `page-load`,
`screenshot`, `console-errors`, and `network-failures` summary checks.
