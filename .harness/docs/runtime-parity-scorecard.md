# Runtime Parity Scorecard

Runtime parity is measured capability, not a promise that every adapter behaves
identically. The scorecard compares Claude and Codex across the capabilities
the harness can verify with deterministic evidence.

Run:

```bash
node .harness/scripts/runtime-parity-report.mjs --strict
node .harness/scripts/runtime-parity-report.mjs --json
node .harness/scripts/runtime-parity-report.mjs --fail-partial
```

## Status Values

- `pass`: the runtime has local or upstream test evidence for the capability.
- `partial`: the runtime has useful coverage, but a known gap remains.
- `fail`: the runtime lacks required coverage.
- `n/a`: the capability does not apply to that runtime.

Scores count `pass` as `1`, `partial` as `0.5`, and skip `n/a`.
The JSON score includes per-runtime counts for `pass`, `partial`, `fail`, and
`n/a` so CI and dashboards can distinguish a high score from full parity.

## Evidence Model

In the kit repo, every advertised capability must point at a test file and a
marker string. Missing files or missing markers fail the report. In generated
installs, those references are treated as upstream kit evidence because the
fixture tests are not copied into user repositories.

The JSON output is a durable artifact and must match
`.harness/schemas/runtime-parity-report.schema.json`.

## Release Use

Release and team strictness tiers include runtime parity as a readiness signal.
Partial capabilities are reported as warnings unless a gate promotes them to
release blockers. Do not claim a runtime is fully supported until the partial
rows are either resolved or explicitly accepted as experimental.
Use `--fail-partial` in release environments where any partial runtime
capability must block the release.
Each partial row carries `promotionCriteria` and `nextSteps`. Treat those as the
current contract for upgrading a runtime capability from `partial` to `pass`;
do not flip the status based on synthetic coverage alone.

For Codex native hook parity, the real Codex E2E driver includes a lifecycle
hook probe. Set `AHK_E2E_CODEX_REQUIRE_HOOKS=1` to make missing hook artifacts a
blocking failure in release environments that are expected to support them. The
probe initializes a git workspace and reports Codex feature/JSONL diagnostics so
missing lifecycle artifacts are actionable instead of silent.
For Codex reviewer parity, set
`AHK_E2E_CODEX_REQUIRE_REVIEWER_ARTIFACT=1` to make missing reviewer decision
artifacts blocking in the real Codex E2E driver.
In the kit repo, prefer the release wrapper so the strict env contract is
repeatable and emits JSON diagnostics:

```bash
npm run check:codex-parity-probes -- --hooks
npm run check:codex-parity-probes -- --reviewer
npm run check:codex-parity-probes -- --all --json
npm run check:codex-parity-probes -- --all --dry-run --json
```

The JSON output includes `probeResults[]`. Release automation should read that
field instead of scraping stdout/stderr tails; it distinguishes a confirmed
probe failure from an `unknown` probe that the E2E driver did not reach before a
different strict probe failed.

## Adding Capabilities

When adding a capability row:

1. Add the scorecard entry in `runtime-parity-report.mjs`.
2. Add at least one deterministic evidence reference.
3. Add generated-install coverage if the capability depends on rendered files.
4. Keep the public status honest: use `partial` when real runtime behavior is
   not yet proven end to end.
