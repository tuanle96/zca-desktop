# Browser Validation

Tier 4 validation for agent-harness-kit projects. It complements transcript/file benchmarks by checking the actual browser experience.

## Features

- Playwright-based UI golden path validation.
- `/verify-ui` skill for Claude Code workflows.
- Screenshot capture.
- Console error capture.
- Network failure and HTTP 4xx/5xx capture.
- JSON and HTML reports under `.harness/ui-validation/`.

## Usage

```bash
# Validate an already-running app
node .harness/scripts/verify-ui.mjs --url=http://localhost:3000

# Start a dev server, validate it, then stop it
node .harness/scripts/verify-ui.mjs --command="npm run dev" --url=http://localhost:3000

# Smoke-test report generation without Playwright
node .harness/scripts/verify-ui.mjs --mock --allow-mock-exit-zero
```

In Claude Code:

```text
/verify-ui --url=http://localhost:3000
```

## Artifacts

Each run writes:

```text
.harness/ui-validation/<run-id>/
├── summary.json
├── report.html
└── screenshots/
    └── home.png
```

`latest.json` points to the newest run summary.

For task evidence, the `summary.json` must be browser evidence and must include
passing `page-load`, `screenshot`, `console-errors`, and `network-failures`
checks. A manually reduced summary is not enough to satisfy a `ui` gate.

## Installing Playwright

Browser validation loads Playwright dynamically. Projects that want real browser checks should install it locally:

```bash
npm install -D playwright
npx playwright install chromium
```

The `--mock` mode is only for verifying report generation in environments without
browsers. It writes `evidenceKind: "mock"` and `evidenceUsable: false`, and it
does not satisfy task evidence. The task evidence checker rejects passing UI
checks that use `verify-ui --mock`.
