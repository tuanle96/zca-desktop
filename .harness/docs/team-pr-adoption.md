# Team and PR Adoption

Team adoption moves harness decisions from a local agent session into CI and PR
review, where maintainers can see the exact gate, evidence, and remediation.

## Baseline Setup

Use the team tier when a repo has more than one maintainer or when PRs are the
release boundary:

```bash
node .harness/scripts/strictness.mjs set team
node .harness/scripts/harness-readiness.mjs --list
```

Generated GitHub workflows run readiness first, then PR annotations with
`if: always()` so failed gates still produce review artifacts.

## PR Artifacts

The PR reporter writes:

- `.harness/reports/pr-annotations.md`
- `.harness/reports/pr-annotations.json`
- `.harness/reports/pr-annotations.sarif`

It aggregates readiness, task/evidence validation, advisor and reviewer state,
bypass audit, architecture fitness, evidence attestation, and runtime parity.
GitHub annotations are best-effort; Markdown and SARIF are the portable review
surface for forks and local CI.

## Review Policy

Use these defaults for team repos:

- Keep `harness-readiness.mjs --strict` as the blocking CI gate.
- Require passing task evidence before merging implementation PRs.
- Promote actionable `block` or `needs-human` review findings into failure
  records instead of leaving them as loose comments.
- Treat unreviewed bypasses as release blockers.
- Keep policy packs selected in config so stack-specific fitness rules run in
  CI, not only in local sessions.

## Operational Handoff

Before handoff or release, attach the dashboard and PR artifacts:

```bash
node .harness/scripts/harness-report.mjs --html
node .harness/scripts/pr-annotations.mjs --out=.harness/reports/pr-annotations.md --sarif-out=.harness/reports/pr-annotations.sarif
node .harness/scripts/harness-state.mjs export --redact > .harness/reports/state-export.redacted.json
```

Redacted state exports are safe for review. Unredacted exports should stay
local because traces can contain prompts, paths, and operational context.
