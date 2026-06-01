# Multi-Agent Orchestration Patterns

- Pipeline: sequential handoff when each step depends on the prior result.
- Fan-out/Fan-in: parallel exploration when work can be split safely.
- Expert Pool: independent specialist reviews before a risky change.
- Red Team: adversarial failure-mode search.
- Supervisor: coordinator tracks multiple subtasks and blockers.
- Pair Review: implementer plus reviewer on one narrow change.

## Runtime MVP

`/orchestrate` still supports packet-only planning, but it can also run a bounded
runtime:

```bash
node .claude/skills/orchestrate/orchestrate.mjs "task" --pattern=fanout --run --max-concurrency=3
node .agents/skills/orchestrate/orchestrate.mjs "task" --pattern=fanout --run --max-concurrency=3
node .claude/skills/orchestrate/orchestrate.mjs "task" --pattern=red-team --run --transport=mock
node .agents/skills/orchestrate/orchestrate.mjs "task" --pattern=red-team --run --transport=codex-cli
node .claude/skills/orchestrate/orchestrate.mjs --contract=release-review --run --transport=mock
node .claude/skills/orchestrate/orchestrate.mjs --resume=<run-id-or-dir>
node .claude/skills/orchestrate/orchestrate.mjs --validate-run=<run-id-or-dir>
```

When rendered for Codex, the agents-skill entrypoint defaults to `codex-cli`
transport and records the same manifest, summary, transcript, telemetry, and
validation artifacts as the Claude runtime.

Runtime output lands in `.harness/orchestration/<run-id>/`:

- `manifest.json` — task, pattern, prompts, concurrency, fail-fast policy
- `transcripts/*.jsonl` — one transcript per agent lane
- `summary.json` — pass/fail, cost, token, and cache bucket totals
- `summary.md` — human-readable synthesis input

## Workflow Contracts

For auditable multi-agent work, write
`.harness/orchestration/contracts/<id>.json` and run with `--contract=<id>`.
The contract fixes the pattern, max concurrency, lane ids, lane roles,
`read-only`/`review-only`/`mutating` tool policy, required reviewer lanes,
task/feature binding, and expected output artifacts. Mutating lanes require a
task contract and `requiresEvidence: true`; reviewer requirements must map to
required reviewer lanes.

Generate a contract from an existing task contract when possible:

```bash
node .harness/scripts/orchestration-contract-from-task.mjs <task-id>
```

The generator derives reviewer lanes from `requiredReviewers`, mutating lanes
from `permissions.allow`, output paths from task/evidence ids, and pattern
choice from risk/reviewer state. Validate the generated contract before running
it.

The default scaffold includes
`.harness/orchestration/contracts/health-endpoint-review.json` as a minimal
example: one read-only reliability review lane plus one mutating implementation
lane bound to the `health-endpoint` task contract and evidence bundle.

Validate contracts and recorded runs with:

```bash
node .harness/scripts/check-orchestration-contracts.mjs --strict
```

Runtime hardening:

- `--timeout-ms=N` records stalled lanes as timeout failures.
- `--retries=N` retries failed lanes before final failure.
- `--cancel=<run-id-or-dir>` writes a cancellation marker.
- `--resume=<run-id-or-dir>` restores the manifest/summary and reruns only
  failed or missing lanes.
- `--validate-run=<run-id-or-dir>` validates manifest, summary, and transcript
  JSONL schema.

Use `--no-fail-fast` when every lane should finish even after one lane fails.
Every runtime appends trace rows to `.harness/telemetry.jsonl`, which lets
`session-replay`, `cost-tracker`, and `telemetry-export` close the chain from
orchestration task to skill, provider call, cache buckets, cost, transcript, and
report.
