---
inclusion: always
---

# zca-desktop — Harness Steering

zca-desktop — solo-dev project on the agent-harness-kit harness. Rust + Tauri v2 desktop app (frontend: SvelteKit/Svelte 5 + Tailwind v4 + shadcn-svelte, bun). These rules persist across
sessions. They point to repo-local harness files instead of repeating them.

## Build And Verify

- Install (frontend): `bun install`
- Dev: `bun run tauri dev`
- Build: `bun run build` (frontend) + `cargo build --manifest-path src-tauri/Cargo.toml`
- Test: `cargo test --manifest-path src-tauri/Cargo.toml`
- Lint: `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- Structural: disabled (`config.json#structuralTest.engine=none`) until Rust source under `src-tauri/src/` exists and the Rust adapter is wired.
- Architecture fitness: `node .harness/scripts/check-architecture-fitness.mjs --strict`
- Readiness: `node .harness/scripts/harness-readiness.mjs --strict`

Run the structural and architecture fitness checks before claiming a feature is complete.

## Architecture

Layer order, enforced mechanically (Rust core under `src-tauri/src/`):

`types → config → store → zalo → session → command`

Code may only depend forward through the layer order. The SvelteKit frontend
(`src/`) is the `ui` and talks to `command/` via Tauri `invoke`/`listen`.
See ADR-0003 for the rationale.

Read on demand:

- `.harness/docs/architecture.md` before adding or moving modules.
- `.harness/docs/context-rules.md` before choosing task-phase/risk-lane context.
- `.harness/docs/operational-state.md` before recording or querying intake, stories, backlog, traces, or friction.
- `.harness/docs/trace-quality.md` before final trace/friction recording.
- `.harness/docs/adr/` before changing public APIs.
- `.harness/docs/golden-principles.md` before refactors.
- `.harness/feature_list.json` before claiming a feature is done.
- `.harness/task-contracts/` before source or config mutations.
- `.harness/docs/evidence-bundle.md` and `.harness/schemas/evidence-bundle.schema.json`
  before claiming a task is done.
- `.harness/project/state.json` before changing phase, MVP scope, risks, or checklists.
- `.harness/memory/current-summary.md` for compact shared project memory.
- `.harness/PROGRESS.md` for session progress.

The harness skills are loaded as `skill://` resources under `.kiro/skills/`.
Their metadata is available at startup; load full instructions on demand.

## Mandatory Advisor Protocol

An advisor agent (`.kiro/agents/advisor.json`) exists in this project. It uses a
higher-capability model and MUST be consulted before:

1. Claiming any feature is done (before setting `passes: true`)
2. Any mutation touching auth, secrets, or trust boundaries
3. Any cross-layer architectural change
4. Any new public API surface

The advisor returns a structured JSON decision matching
`.harness/schemas/review-decision.schema.json`. If `decision != "pass"`,
address its findings before proceeding.

## Workflow

1. Inspect the repo and read `.harness/feature_list.json`.
2. Pick one unchecked feature or one explicitly requested task.
3. Bind source/config mutations to a task contract under `.harness/task-contracts/`.
4. Keep `.harness/project/state.json` aligned with phase, risks, and current work.
5. Implement with small diffs and existing local patterns.
6. Run the relevant structural, lint, and test gates.
7. Record operational trace/friction with `.harness/scripts/harness-state.mjs trace` when the task changes code, docs, or harness state.
8. Write the evidence bundle, then update `.harness/feature_list.json` only after end-to-end proof passes.

## Review Lanes

Use Kiro subagents (`.kiro/agents/*.json`) when available, or apply the same
role split manually:

- architecture reviewer for cross-layer changes.
- security reviewer for auth, input handling, secrets, or trust boundaries.
- reliability reviewer for retries, async boundaries, background jobs, and error paths.

Required reviewers must leave structured JSON decisions matching
`.harness/schemas/review-decision.schema.json`, then link those artifacts from
the task evidence bundle.

## What Not To Do

- Do not add a new layer without an ADR.
- Do not install packages with native bindings without an ADR.
- Do not disable the structural test to make a task pass.
- Do not write code that the structural test cannot reason about.
- Do not assume Claude-only slash commands, `@` imports, or settings semantics
  exist in Kiro CLI. Kiro reads steering files, `skill://` resources, and
  per-agent hooks instead.
