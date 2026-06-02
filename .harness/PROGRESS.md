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

## Readiness fix — harness-config-skillsdir (2026-06-01)
- 2026-06-01 15:50 | harness-config-skillsdir | done
- Strict readiness was RED: `.harness/config.json` (skillExamples.skillsDir .claude/skills -> .kiro/skills) sat in the git diff with no owning evidence, failing task-evidence + evidence-attestation.
- Registered a `harness`-type task: task contract + attested evidence bundle (structural no-op + check-skill-examples, both via evidence-run) + mandatory advisor pass decision; flipped the feature to passes:true so strict current-diff coverage includes the config change.
- `package.json` (harness:check script) was already covered by tauri-scaffold; `.harness/scripts/harness-check.mjs` is harness tooling.
- Gates green: `harness-readiness.mjs --strict` PASSED (all 14 gates); task-evidence --verify-hashes --replay-plan OK; trace-quality --strict OK.

## Phase 1 — zca-dep-wired (2026-06-02)
- 2026-06-02 01:00 | zca-dep-wired | done
- Added zca-rust as a pinned git dep (rev 08698e1c, rustls TLS — no native bindings) + tokio to src-tauri/Cargo.toml.
- Created the `zalo/` layer (src-tauri/src/zalo/mod.rs) wrapping `Zalo::new(None).login()`, re-exporting API + Credentials + ZaloError; lib.rs declares the module. Forward-only layering preserved (nothing above zalo yet).
- Offline test: `zalo::login` rejects empty credentials via zca-rust validation (no network call). Credentials never logged (no Debug derive upstream).
- Gates green: cargo build OK (~37s cold), clippy --all-targets -D warnings clean, cargo test 1 passed; harness-readiness --strict PASSED; review-coverage --strict OK (advisor pass).
- Decision d7 recorded (pinned git rev, rustls, no new ADR).

## Hardening — app-csp-hardening (2026-06-02)
- 2026-06-02 01:15 | app-csp-hardening | done
- Set a restrictive baseline CSP on the Tauri webview (was csp:null): script-src 'self', explicit IPC connect-src so invoke/listen still work — closes the main XSS-exec vector before any credential handling.
- Fixed the scaffold placeholder window/document title -> "Zalo Desktop".
- Added @types/node + removed a now-stale @ts-expect-error in vite.config.js -> svelte-check 0 errors / 0 warnings.
- Gates: cargo build (config parses) OK, npm run check 0/0, npm run build OK, harness-readiness --strict PASSED, review-coverage --strict OK (advisor pass).
- Accepted risk csp-runtime-unverified (low, acceptedUntil 2026-07-01): live CSP header to be GUI-verified via inspect-app before credentials land.
- Note: bun.lock present but bun not installed; @types/node installed via npm --no-save --no-package-lock to avoid a competing lockfile.
