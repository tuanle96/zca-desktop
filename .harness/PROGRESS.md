# Session progress

_Append a one-line entry per completed feature. Format: `YYYY-MM-DD HH:MM | <feature_id> | done`._

## Phase 1 — tauri-scaffold (in progress)
- Scaffolded Tauri v2 + SvelteKit(SPA) + TS via create-tauri-app (bun), renamed to zca-desktop.
- Added Tailwind v4 (@tailwindcss/vite) + shadcn-svelte (zinc/nova/lucide); Button component added.
- Verified: `bun run build` (0 errors), `cargo build` (52s), `tauri info` (Tauri 2.11.2 / Svelte / Vite).
- Remaining: `bun run tauri dev` window smoke (manual GUI check).

## Harness compliance + AGENTS.md (2026-06-01)
- Created AGENTS.md (table-of-contents agent file; stack, layers, commands, hard rules, secrets).
- ADR-0003: Rust core layering types->config->store->zalo->session->command (supersedes ADR-0001 layer order); synced architecture.md, golden-principles #1, steering.
- Fixed steering harness.md: rust/tauri/bun commands + layer order.
- tauri-scaffold marked passes:true with proof: task contract + attested evidence bundle (frontend.build + rust.build via evidence-run). Window smoke verified via user screenshot.
- Removed orphan placeholder task contracts (health-endpoint, not-found-page).
- Gates green: task-evidence-check OK, evidence-attestation OK, doctor readiness preflight OK.
