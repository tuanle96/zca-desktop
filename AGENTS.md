# AGENTS.md — zca-desktop

Cross-platform **Zalo desktop client** (personal-use, unofficial). Rust **Tauri v2** core
hosting multiple concurrent [`zca-rust`](https://github.com/tuanle96/zca-rust) sessions; **SvelteKit / Svelte 5
+ Tailwind v4 + shadcn-svelte** frontend; **bun** package manager. Dev is governed by
**agent-harness-kit** (Kiro runtime). This file is a table of contents — the authoritative,
always-on rules live in `.kiro/steering/harness.md`; read the `.harness/*` files on demand.

## Stack & layout
- Rust core: `src-tauri/src/` — layers `types → config → store → zalo → session → command` (forward-only; ADR-0003).
- Frontend (`ui`): `src/` (SvelteKit SPA, `ssr=false`) → calls core via Tauri `invoke`/`listen`.
- shadcn-svelte components in `src/lib/components/ui/`; `cn` in `src/lib/utils.ts`; theme in `src/app.css`.

## Commands
- Dev: `bun run tauri dev`  ·  Frontend build: `bun run build`  ·  Type-check: `bun run check`
- Rust build/test/lint: `cargo build|test|clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- Readiness gate: `node .harness/scripts/harness-readiness.mjs --strict`
- Add shadcn component: `bunx shadcn-svelte@latest add <name>`

## Harness workflow (follow every task)
1. Read `.harness/feature_list.json`; pick exactly one feature or the explicitly requested task.
2. Before mutating source/config, create/activate a task contract in `.harness/task-contracts/`.
3. Keep `.harness/project/state.json` (phase, scope, risks) current.
4. Implement small diffs that mirror existing local patterns.
5. Run the relevant build/test/lint gates; verify before claiming done.
6. Write an evidence bundle (`.harness/evidence/<id>.json`) and only then set `passes: true`.

## Hard rules
- No `passes: true` without a machine-readable evidence bundle (proof of build/test/smoke).
- Respect the forward-only layer order; do not add/rename a layer without an ADR (`.harness/docs/adr/`).
- Do not weaken or disable structural/harness checks to make a task pass.
- Consult the advisor (`.kiro/agents/advisor.json`) before: claiming done, auth/secret/trust-boundary changes, cross-layer changes, or a new public API.
- **Secrets:** Zalo credentials (imei + cookie + userAgent) are bearer tokens. Store in the OS keychain only; never log/echo values or commit them (`.gitignore` blocks `*.cred.json`, `cookies.json`).

## Project posture
- Unofficial Zalo API — personal use; avoid spam-like automation (ban risk).
- Build on zca-rust's verified endpoints first; gate unverified ones behind live-test evidence.
- Kiro note: only 5/9 lifecycle hooks fire and the Stop hook is advisory (warn-only) — compliance is on the agent, not just the hook.

## Pointers
- Roadmap/backlog → `.harness/feature_list.json`  ·  Phases/risks/decisions → `.harness/project/state.json`
- Architecture → `.harness/docs/architecture.md`  ·  Invariants → `.harness/docs/golden-principles.md`
- Model routing (Opus=impl, Sonnet=review, Haiku=explore) → `.harness/config.json#models`
- Session memory → `.harness/memory/current-summary.md`  ·  Progress log → `.harness/PROGRESS.md`
