# Tier 2 Regression Benchmark

This suite moves beyond smoke tests by running 24 regression tasks across kit failure classes:

- missing-test
- wrong-file
- layer-violation
- doc-drift
- skill-skip
- template-drift
- provider-regression
- telemetry-regression

Each task has required files and hidden checks. `.harness/scripts/regression-runner.mjs` can run in mock mode for framework verification or `claude-cli` mode for real API-backed evaluation. Results include pass rate, duration, token/cost metrics, interventions, transcript paths, changed files, and multi-session stability.

Useful runs:

```bash
.harness/scripts/regression-runner.mjs --transport=mock --variant=current
.harness/scripts/regression-runner.mjs --transport=claude-cli --variant=current --limit=5
.harness/scripts/regression-runner.mjs --transport=claude-cli --variant=current --sessions=3 --quality-threshold=0.9 --decay-threshold=0.1
```

`--sessions=N` repeats each task and reports per-session distribution, flaky tasks, and quality decay from the first to last session.

Use `.harness/scripts/regression-report.mjs` to generate an HTML dashboard and `.harness/scripts/regression-compare.mjs` for A/B comparison.
