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

## Phase 1 — credential-import (2026-06-02)
- 2026-06-02 02:20 | credential-import | done
- Added the `types/` layer: Credentials + Cookie + CredentialError (credentials.rs), AccountId + AccountProfile + CredentialSummary (account.rs). Pure data, no zca-rust dependency (ADR-0003 lowest layer).
- Added the `command/` layer: import_credentials parses ZaloDataExtractor JSON, validates required fields, returns a non-secret CredentialSummary (lengths + counts only). Token values never cross IPC; nothing persisted (Phase 3).
- Minimal frontend (+page.svelte): paste JSON → invoke → render summary / error.
- 6 cargo tests: valid import, malformed JSON, empty cookies, blank imei, language default, plus the existing zalo login test.
- Reviews: advisor pass + architecture-reviewer pass (cross-layer types+command, forward-only DAG verified).
- Gates: cargo build/clippy -D warnings/test OK, svelte-check 0/0, npm run build OK, harness-readiness --strict PASSED, review-coverage --strict OK (5 pass decisions).

## Phase 1 — single-login (2026-06-02) [LIVE]
- 2026-06-02 03:46 | single-login | done
- zalo/login_profile: maps types::Credentials -> zca_rust::Credentials (mapping stays inside the zalo layer so types is zca-rust-free), logs in, returns AccountProfile (get_own_id + best-effort fetch_account_info display name).
- command/login: validates payload at the boundary, returns only the non-secret AccountProfile; lib.rs registers it. UI adds a Log in button showing account id/name.
- LIVE smoke: single_login_live (#[ignore]) read the gitignored .zalo-cred.json and logged in a real account — uid_len=19, has_display_name=true. Attested stdout sidecar scanned: no token values present.
- Reviews: advisor + security-reviewer + architecture-reviewer all pass.
- Gates: cargo build/clippy -D warnings/test (7 offline + 1 live) OK, svelte-check 0/0, npm build OK, harness-readiness --strict PASSED, review-coverage --strict OK (8 pass decisions).
- MVP checklist: tests-pass -> done.

## Phase 1 — listener-events (2026-06-02) [LIVE]
- 2026-06-02 04:24 | listener-events | done
- types/events.rs: IncomingMessage + ThreadKind DTOs (no zca-rust dep).
- zalo/: start_message_listener builds the Listener from login_info.zpw_ws, maps ListenerEvent::Message -> IncomingMessage (mapping confined to zalo), forwards over mpsc. Also added login_with(self_listen), profile_of, send_text.
- command/start_listening: login -> spawn bridge -> emit zalo://message Tauri events; Listener kept alive in ListenerState managed state. Frontend subscribes and renders incoming messages.
- LIVE round trip: self_listen login + send marker to authorized recipient (resolved by phone) -> bridge surfaced it (thread_kind=User, msg_id present, is_self=true). Attested sidecar scanned: no credentials, no recipient phone.
- Reviews: advisor + security + reliability + architecture all pass.
- Gates: cargo build/clippy -D warnings/test (7 offline + 1 live) OK, svelte-check 0/0, npm build OK, harness-readiness --strict PASSED, review-coverage --strict OK (12 pass decisions).
- Note: sending to own uid returned code 114; round trip uses a real recipient + self_listen instead.

## Phase 1 — send-text (2026-06-02) [LIVE]
- 2026-06-02 04:36 | send-text | done
- command/send_message: validates thread_id/text, reuses an authenticated session from ListenerState (now HashMap<AccountId, Arc<API>> populated on start_listening), delegates to zalo/send_text. Credentials never re-sent from the UI.
- Frontend composer (thread id + message) calls send_message and shows the returned msgId.
- LIVE send: one real text delivered to the authorized recipient (Lê Anh Tuấn, resolved by phone); Zalo returned a msgId. Attested sidecar scanned: no credentials, no recipient phone.
- Reviews: advisor + security + architecture pass. Accepted risk send-throttle-missing (medium, until 2026-07-15): add per-account send throttling in the session layer.
- Gates: cargo build/clippy -D warnings/test (7 offline + 1 live) OK, svelte-check 0/0, npm build OK, review-coverage --strict OK (15 pass decisions), harness-readiness --strict PASSED.

## Harness fix — permissions-compiler stdout truncation (2026-06-02)
- harness-report's `harness:report` gate went RED: it spawns `permissions-compile.mjs diff --json` and parses stdout, but the compiled JSON grew past the ~64KB stdout pipe buffer and `process.exit()` truncated the write before flush.
- Root-cause fix in `.harness/scripts/_lib/permissions/compiler.mjs`: defer `process.exit()` to the `process.stdout.write` callback so the full payload flushes. Verified full 67KB JSON now parses via spawnSync. (Golden principle #7: fix the mechanism.)
