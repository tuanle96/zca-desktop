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

## Phase 1 — dev-session-loader (2026-06-02) [LIVE + GUI]
- 2026-06-02 05:01 | dev-session-loader | done
- Security-driven change (user flagged credential paste leaks the token): the Rust core now reads .zalo-cred.json from a fixed repo-local path (env ZALO_CRED_FILE or repo root); the UI supplies no path, so no arbitrary file read.
- command/: cred_file_summary, login_from_file, start_listening_from_file; login/listen refactored into a shared login_and_listen helper. Frontend replaced the credential textarea with buttons (Check session / Log in / Log in + listen) — imei/cookie/userAgent never enter the webview DOM.
- GUI verified via `tauri dev` (npm fallback override tauri.dev-npm.conf.json since bun is absent): logged in as the real account, profile shown.
- Live file smoke: cred_file_summary (8 cookies, vi) + login_from_file (uid_len=19, display name). Sidecar scanned: no secrets.
- Reviews: advisor + security + architecture pass. Accepted risk dev-cred-file-affordance (medium, until 2026-07-15): replace with file picker + OS keychain in secure-cred-store.
- Gates: cargo build/clippy -D warnings/test (8 offline + 2 live) OK, svelte-check 0/0, npm build OK, review-coverage --strict OK (18 pass decisions), harness-readiness --strict PASSED.

## Phase 1 — chat-ui-redesign (2026-06-02) [GUI + browser-verified]
- 2026-06-02 05:48 | chat-ui-redesign | done
- Zalo-style 3-pane layout with shadcn-svelte: RailNav (brand-blue icon rail), ConversationList (search + rows w/ avatar/snippet/time/unread), ChatPane (header + bubbles + composer), ConnectBar (login/listen/open-thread).
- Reactive session store (src/lib/session.svelte.ts) wraps the existing IPC commands and derives conversations + per-thread messages from the live zalo://message stream — no mock data. Outgoing sends via send_message render optimistically.
- Added shadcn-svelte components (avatar/input/scroll-area/separator) + bits-ui; added a Zalo brand color in app.css.
- Frontend-only: Rust core untouched. ui unit reaches the core only through command/ IPC (ADR-0003 preserved).
- Real browser validation: installed Playwright+chromium, ran verify-ui golden path against the running app — page-load 200, screenshot, 0 console errors, 0 network failures (browser evidence, usable).
- Reviews: advisor + architecture pass. Accepted risk ui-placeholders (low, until 2026-08-01): secondary rail tabs + header icons are visual-only.
- Gates: svelte-check 0/0, npm build OK, cargo build OK, attested ui check, harness-readiness --strict PASSED, review-coverage --strict OK (20 pass decisions).
- Note: bun.lock stale for bits-ui (bun absent); refresh with bun install on a bun-equipped machine.

## Phase 4 (early) — thread-list / contacts (2026-06-02) [LIVE + GUI]
- 2026-06-02 06:16 | thread-list | done
- types/contact.rs: Contact DTO (no zca-rust). zalo/list_contacts maps get_all_friends User -> Contact (sorted, zca-rust confined to zalo). command/list_contacts reuses the stored session.
- Frontend: ContactList (Danh bạ) pane — avatars, search, A–Z groups; rail nav switches chats/contacts; clicking a contact opens a DM. Avatars load from Zalo CDN (CSP img-src widened to *.zadn.vn / *.zalo.me).
- LIVE: list_contacts loaded 85 real contacts. Real browser verify-ui passed.
- Scroll fix: shadcn ScrollArea inside a flex column needs min-h-0 on every flex ancestor; added across list/chat panes + page wrapper. Excluded .harness/** from the Vite dev watcher so verify-ui runs don't reload the app.
- Reviews: advisor + security + architecture pass. Gates: cargo build/clippy/test, svelte-check 0/0, npm build, attested ui, harness-readiness --strict PASSED.
- Scope note: feature narrowed to friends/contacts; groups (get_all_groups) deferred.

## Memory checkpoint (2026-06-02)
- Recorded shared memory (`.harness/memory/ledger.jsonl`): credential-never-in-webview decision, live-verification pattern, UI/core IPC-only + no-mock-data decision, consolidated dev-affordance risks, and a Phase 1 handoff note. current-summary.md refreshed.

## Phase 2 — qr-login core (2026-06-02, in progress)
- ADR-0004 (credential lifecycle + imei strategy): canonical credential = triple {imei, cookie, user_agent}; QR + cookie-import converge on it; stable per-(account,install) imei; per-device QR (no session cloning) for multi-device coexistence; keychain storage; explicit none/active/reauth-needed lifecycle.
- Added feature `qr-login` (high-risk, requiresAdr) to feature_list.json + task-contracts/qr-login.json (allowedLayers types/zalo/command; narrowed high-risk permissions; reviewers advisor+security+architecture).
- types/: new `QrLoginEvent` DTO (qr.rs) — non-secret QR stages (generated/scanned/declined/expired/success); token-bearing data never modeled here.
- zalo/: `run_qr_login(events)` wraps zca-rust `apis::login_qr::login_qr`, maps LoginQREvent->QrLoginEvent (drops token-bearing GotLoginInfo), generates imei via `crypto::generate_zalo_uuid` (uuid+"-"+MD5(ua)), extracts cookies from the opaque reqwest Jar across Zalo hosts, assembles+validates Credentials. Added reqwest 0.12 (rustls, cookies) as a direct dep for CookieStore::cookies — already in tree, no new ADR.
- command/: `start_qr_login` streams QrLoginEvent to UI via `zalo://qr` Tauri event, then reuses login_and_listen; credential triple never crosses IPC. Registered in lib.rs invoke_handler. Capabilities already cover events via core:default.
- Tests: 5 new offline unit tests (event mapping non-secret, imei shape, empty-jar rejection, cookie extraction) + interactive `qr_login_live` smoke (#[ignore]). cargo test 12 passed / 7 ignored.
- Gates green so far: cargo build OK, clippy --all-targets -D warnings clean, architecture-fitness --strict OK.
- Remaining for the feature: UI QR modal (frontend, outside Rust core), live phone-scan smoke, advisor + security/architecture review, evidence bundle, then passes:true.
- UI QR modal (frontend, outside Rust core): added types QrLoginEvent/QrPhase; session store gains qr* state + startQrLogin()/closeQr() + zalo://qr listener (applyQrEvent); new QrLoginModal.svelte (Zalo-PC-style: QR render, loading/waiting-scan/scanned avatar preview/success/declined/expired/error phases, retry+cancel); wired into +page.svelte; ConnectBar gains "Đăng nhập bằng QR" (primary) + "Đăng nhập từ file" (dev). Credential triple never enters the webview — UI consumes only QrLoginEvent + AccountProfile.
- Advisor review (read-only) on the core: decision needs-human (no blocking defect; secret-handling/layering/imei/robustness verified). Persisted .harness/reviews/qr-login/advisor-decision.json. Pending for done: live phone-scan smoke, security+architecture reviewers, evidence bundle.
- Gates green: svelte-check 0/0, vite build OK, frontend diagnostics clean. (bun not installed — used npm; bun-specific contract commands deferred.)
- Live QR bug fix (upstream zca-rust): live scan succeeded but the flow failed at the end with `missing field 'info'`. Root cause = zca-rust login_qr get_user_info() hard-deserialized UserInfoData{logged, info} but /jr/userinfo doesn't always return `info`, rejecting an already-valid session (cookies set by the prior check_session). Fixed in zca-rust: info -> Option + logged serde(default), and the trailing userinfo probe is now best-effort (falls back to the scan-time public profile). Pushed branch fix/login-qr-userinfo-optional (rev 7584bae); zca-rust build+clippy clean. Re-pinned src-tauri/Cargo.toml 08698e1 -> 7584bae; desktop cargo build/clippy/test still green (12 passed/7 ignored). Re-pin to main after the branch merges.

## Logging + raw capture + QR cookie fix (2026-06-02)
- QR expiry: upstream zca-rust `qr_timeout` was dead code (infinite poll, QRCodeExpired never emitted). Fixed in zca-rust (rev 47bd555): bound waiting-scan with tokio::time::timeout -> emit QRCodeExpired + LoginQRAborted. Desktop re-pinned 7584bae -> 47bd555; QrLoginEvent::Generated now carries expiresInSecs (QR_VALIDITY_SECS=100) so the UI can show a countdown.
- Logging infra (NEW `config` layer, ADR-0003 types->config->store->zalo->session->command): config/mod.rs (env: ZCA_LOG/RUST_LOG, ZCA_LOG_DIR, ZCA_LOG_RAW), config/logging.rs (tracing console + rolling daily file under <app-data>/zca-desktop/logs; capture_raw() one-line grep-friendly raw API capture), config/redact.rs (mask imei/cookie/zpw_enk/secret/token/zpsid/zpw_sek/... in JSON + key=value; length-preserving, no content). Redaction ON by default; ZCA_LOG_RAW=1 opt-in unredacted (startup warning). lib.rs inits logging at startup, holds the appender guard for app lifetime. command/log_from_ui bridges webview logs into the same sink; src/lib/log.ts forwards UI logs. .gitignore now ignores /logs/ + *.log. Doc: .harness/docs/logging.md.
- Live bug `missing zpw_enk` (after successful scan, at cookie-login): root cause = cookies_from_jar lost auth cookies. reqwest CookieStore::cookies(url) only returns cookies matching that exact host/path; zca-js instead dumps the whole jar. Fix: query a broad Zalo host set (zalo.me/chat/wpa/id/jr) + tag reconstructed cookies with the apex domain `.zalo.me` so they attach to every *.zalo.me login request. Added redacted diagnostics (cookie NAMES + count) via tracing + capture_raw to confirm on the next live scan.
- Gates: cargo build OK, clippy --all-targets -D warnings clean, cargo test 16 passed/7 ignored (3 redact + 1 logging test new), svelte-check 0/0, architecture-fitness --strict OK (config layer recognized).

## Avatars: own profile + conversation/contact (2026-06-02)
- Issue: no avatars rendered. Root cause = AccountProfile (Rust DTO + TS) had no avatar field and profile_of/fetch_display_name discarded info.profile.avatar; Conversation rows + RailNav/ChatPane only rendered initials (no Avatar.Image). ContactList already wired correctly.
- Fix #1 own avatar: types/account.rs AccountProfile gains `avatar: Option<String>`; zalo/profile_of now fetch_profile_fields() reads both display_name + avatar from fetch_account_info (User.avatar). TS AccountProfile gains avatar. RailNav renders Avatar.Image from session.profile.avatar.
- Fix #2 conversation/contact avatars: Conversation type gains `avatar`; session store resolves peer avatar from loaded contacts (avatarFor), sets it in appendMessage/openThread, and backfills existing rows when loadContacts() completes. ConversationList + ChatPane header render Avatar.Image. CSP img-src already allows *.zadn.vn/*.zalo.me (avatar CDN) — no change needed.
- Gates: cargo build OK, clippy --all-targets -D warnings clean, cargo test 16/7, svelte-check 0/0, vite build OK.
- NOT done in this slice (separate work): message history / existing conversations at login — upstream has no recent-conversations or 1:1 history API (only group history). Tracked for a dedicated feature + ADR.

## Local persistence: SQLite + encrypted credential store + session restore (2026-06-02)
- Complaint: closing the app drops the in-RAM session -> always back to QR. Decision: ADR-0005 (SQLite local DB + encrypted credential store). Supersedes plaintext-free intent of secure-cred-store/message-cache/session-restore.
- ADR-0005: rusqlite (bundled SQLite, no system lib) for accounts/threads/messages/attachments; credential triple AES-256-GCM encrypted with a random 32-byte master key held ONLY in the OS keychain (keyring v3, per-OS native feature), stored as ciphertext in SQLite; session auto-restore on startup. Requires ADR (native/bundled deps + cross-layer + secrets) — recorded. state.json decision d8.
- store/ layer (NEW, ADR-0003 slot): store/crypto.rs (keyring master key generate-once/load + AES-GCM seal/open of the credential blob; keyring+aes-gcm confined here), store/db.rs (rusqlite connection+WAL, schema v1 with user_version migration, save_account/load_accounts/mark_reauth_needed/delete_account; rusqlite confined here). Deps added: rusqlite 0.37 (bundled), aes-gcm 0.10, rand 0.8, thiserror 2, keyring 3 (apple-native/windows-native/sync-secret-service per target).
- command/: StoreState managed handle; login_and_listen now persists account+encrypted credential (best-effort) for QR/payload/file logins; restore_sessions command re-logs-in saved accounts on startup, marks failed ones reauth-needed without disturbing others. lib.rs opens <app-data>/zca-desktop/zca.db at startup (graceful None on failure), registers restore_sessions.
- Frontend: session.restore() calls restore_sessions on app mount; +page.svelte shows a brief "Đang khôi phục phiên đăng nhập…" loader while restoring, then chat shell if restored else QR gate. session.restoring flag added.
- Security: credential never plaintext on disk (AES-GCM), only master key in keychain, never crosses IPC. Test asserts on-disk blob is ciphertext (no plaintext cookie value).
- Gates: cargo build OK, clippy --all-targets -D warnings clean, cargo test 21 passed/8 ignored (crypto seal/open + wrong-key + truncated + json-roundtrip + db migrate/delete; cred_store_roundtrip #[ignore] touches real keychain), svelte-check 0/0, vite build OK, architecture-fitness --strict OK (store layer recognized).
- Pending for secure-cred-store passes:true: live cred_store_roundtrip + relaunch auto-restore smoke, advisor+security+architecture review, evidence bundle. Slice 2 (message-cache: persist messages/attachments) is the next feature.

## Slice 2 message-cache + review round (2026-06-02)
- message-cache (ADR-0005 slice 2): store/db.rs gains thread/message/attachment repositories (save_message upsert+dedupe by (account_id,msg_id)+unread, save_attachment, load_threads, load_recent_messages, clear_unread); types/stored.rs StoredThread/StoredMessage/History; command/ persists incoming (listener bridge) + outgoing (send) messages, load_history + mark_thread_read commands, restore persists messages too; frontend session.hydrateHistory() loads threads+messages at login/restore so prior chats show without a realtime event; selectThread persists read state. Anti message-loss: every observed message mirrored to SQLite.
- Gates: cargo build OK, clippy --all-targets -D warnings clean, cargo test 23 passed/8 ignored (message dedupe/threads/attachment tests new), svelte-check 0/0, vite build OK, architecture-fitness --strict OK.
- Commits: feat/qr-login-persistence-logging branch — 7fac2d7 (qr-login+persistence+logging+UI) and 782cf20 (message-cache). Pushed (PR link available). NOT merged to main.
- Reviews (read-only) for secure-cred-store: advisor + security-reviewer + architecture-reviewer all = needs-human, NO blocking findings. Code verified sound (AES-256-GCM at rest, keychain master key, store-confined deps, no token across IPC, parameterized SQL, redaction covers zpw_sek/zpsid). Persisted under .harness/reviews/secure-cred-store/. qr-login advisor decision recorded earlier (needs-human).
- Readiness: all REQUIRED gates green (task-evidence, evidence-attestation, review-coverage, architecture-fitness, permissions-drift, structural, hooks, schemas). Optional harness-report flags the needs-human reviews (correct signal).
- BLOCKED ON USER (device-only live smoke) before passes:true for qr-login / secure-cred-store / message-cache:
  1. `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored cred_store_roundtrip --nocapture` (keychain+ciphertext roundtrip)
  2. QR scan live + tắt/mở lại app to verify auto-restore + history hydration on the GUI
  3. then author evidence bundles + flip reviewers to pass + set passes:true
- Accepted known risk to record in evidence: message bodies stored plaintext at rest (user data, not bearer token; whole-DB encryption deferred to a future ADR per ADR-0005).
