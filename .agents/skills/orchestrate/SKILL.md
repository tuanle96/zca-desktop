---
name: orchestrate
description: Select and run a multi-agent workflow pattern for work that exceeds one agent's reliable scope. Use for parallel research, independent reviews, cross-domain changes, or high-risk implementation planning.
allowed-tools: Read, Grep, Glob, LS, Bash(node .kiro/skills/orchestrate/orchestrate.mjs:*), Bash(node .harness/scripts/orchestration-contract-from-task.mjs:*)
suggested-turns: 10
---

# Multi-Agent Orchestration

Chooses one of six team patterns. By default it produces an agent execution packet; with `--run` it runs the pattern as an MVP orchestration runtime and records transcripts, cost, token, and cache metrics.

## Patterns

1. `pipeline` — sequential handoff: explore → plan → implement → review.
2. `fanout` — parallel independent investigation, then synthesize.
3. `fanin` — collect outputs from several agents into one decision.
4. `expert-pool` — ask specialized reviewers for second opinions.
5. `red-team` — adversarial review for security/reliability risks.
6. `supervisor` — one coordinator tracks subtask completion.

## Steps

```bash
node .agents/skills/orchestrate/orchestrate.mjs "task description" --pattern=fanout
node .agents/skills/orchestrate/orchestrate.mjs "task description" --pattern=fanout --run --max-concurrency=3
node .agents/skills/orchestrate/orchestrate.mjs "task description" --pattern=fanout --run --transport=mock
node .agents/skills/orchestrate/orchestrate.mjs "task description" --pattern=fanout --run --transport=codex-cli
node .harness/scripts/orchestration-contract-from-task.mjs <task-id>
node .agents/skills/orchestrate/orchestrate.mjs --contract=release-review --run --transport=mock
node .agents/skills/orchestrate/orchestrate.mjs --resume=<run-id-or-dir>
node .agents/skills/orchestrate/orchestrate.mjs --validate-run=<run-id-or-dir>
```

Packet mode writes `.harness/docs/orchestration/<timestamp>-<pattern>.md`.
When this skill is rendered for Codex under `.agents/skills`, runtime mode
defaults to `--transport=codex-cli`; Claude-rendered skills default to
`--transport=claude-cli`.

Use `orchestration-contract-from-task.mjs <task-id>` to derive a contract from
the task contract's risk tier, required reviewers, permissions, and evidence
path before running high-risk or mutating multi-agent work.

Contract mode reads `.harness/orchestration/contracts/<id>.json` and binds the
run to explicit lanes, tool policies, required reviewers, task ids, and output
artifacts. Use it for high-risk work or any multi-agent run that should be
auditable after the fact.

Runtime mode writes `.harness/orchestration/<run-id>/manifest.json`, per-agent transcripts, `summary.json`, and `summary.md`. Each `summary.results[*]` row includes `runtimeProof` with `type=orchestration-run`, `eventId`, `inputHash`, and `path`; copy that object into `provenance.runtimeProof` when a review decision claims `source=review-agent`. It also appends orchestrate telemetry to `.harness/telemetry.jsonl` so cost/replay/export tools can trace `task -> skill -> provider call -> cache bucket -> cost`. Use `--no-fail-fast` when you need every lane to finish even after a failure.

Hardening flags:

- `--timeout-ms=N` kills a stalled lane and records a timeout result.
- `--retries=N` retries failed lanes before marking them failed.
- `--resume=<run-id-or-dir>` skips previously passed lanes and reruns missing/failed lanes.
- `--cancel=<run-id-or-dir>` writes a cancellation marker consumed by resume/running lanes.
- `--validate-run=<run-id-or-dir>` checks manifest, summary, and JSONL transcript schema.

## Output contract

```markdown
### Orchestration: <pattern>
### Agents: <count>
### Packet: .harness/docs/orchestration/<timestamp>-<pattern>.md
### Synthesis owner: main agent
```
