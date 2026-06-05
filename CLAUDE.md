# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Unofficial cross-platform **Zalo desktop client**, personal/noncommercial use only. Three components:

- **Desktop core** (`apps/desktop/src-tauri/`) — Rust, **Tauri v2**. Hosts concurrent [`zca-rust`](https://github.com/tuanle96/zca-rust) Zalo sessions, talks to the cloud server over HTTP, and is the only place credentials live in plaintext.
- **Frontend** (`apps/desktop/src/`) — **SvelteKit / Svelte 5 + Tailwind v4 + shadcn-svelte**, SPA (`ssr=false`, `adapter-static`). Runs in the Tauri webview; reaches the core only via `invoke`/`listen`.
- **Cloud server** (`apps/server/`) — Rust **axum + sqlx** on Postgres + S3. Email magic-link auth, server-hosted Zalo sessions, and an encrypted message/media store.

`bun` is the package manager. `AGENTS.md` is the short rules digest; `CONTRIBUTING.md` and `server/README.md` have the long form.

### Monorepo layout (shared code + mobile)

Shared code is factored out so a **mobile app** can reuse it without duplicating the desktop:

- **`packages/`** (bun workspaces, TS) — `@zca/types` (display DTOs) and `@zca/core-client` (the `invoke()` cloud wrappers). The desktop's `src/lib/types.ts` and `src/lib/cloud.ts` are now thin **re-export shims** of these, so existing `$lib/*` imports are unchanged; new/shared code imports `@zca/*` directly.
- **`crates/`** (Cargo, Rust):
  - `zca-keychain` — OS-keychain wrapper (keyring on desktop/iOS; app-private file store on Android). Token storage for both cores.
  - `zca-cloud-client` — Tauri-agnostic HTTP/SSE client; the **single Rust home for the `/api/v1` contract**. The desktop's `command/cloud.rs` and the mobile core are thin wrappers over it.
  - `zca-types` — the **single Rust source of truth for the wire DTOs**. EXCLUDED from the clients workspace (its optional `sqlx` dep would drag `sqlx-sqlite`/`libsqlite3-sys` into the clients lock and collide with `rusqlite`). The server re-exports it (FromRow via the `sqlx` feature); `cargo test --manifest-path crates/zca-types/Cargo.toml --features ts` regenerates `packages/types/src/generated/contract.ts`.
- **`apps/mobile/`** — a **Tauri Mobile** thin client (SvelteKit shell + small Rust core). Reuses `@zca/types` + `@zca/core-client` and `zca-keychain` + `zca-cloud-client`, registers the **same `cloud_*` IPC commands** as the desktop (so `@zca/core-client` works unchanged), and keeps the device token in the OS keychain (passed as the `__keychain__` sentinel, never in the webview). No `rusqlite`, no `zca-rust` on device.

**Two Cargo workspaces, not one.** The root `Cargo.toml` is the **clients** workspace (`src-tauri` + `crates/*` + `apps/mobile/src-tauri`, one lockfile). The server keeps its **own** workspace (`server/Cargo.toml`). They *cannot* merge: the desktop links the `sqlite3` native lib via `rusqlite` (bundled) and the server links it via `sqlx`'s `sqlx-sqlite` (pulled by `sqlx-macros-core`); Cargo forbids two packages linking the same native lib and no `libsqlite3-sys` version satisfies both. Shared Rust is therefore native-lib-free path-crates only — and `zca-types` is a **third, standalone** crate (excluded from clients) because its optional `sqlx` is resolved into the lock even when off.

## Commands

```bash
# Desktop app (frontend + Tauri shell, hot-reload) — lives in apps/desktop
bun install                            # at the repo root: links the bun workspaces
(cd apps/desktop && bun run tauri dev)
(cd apps/desktop && bun run build)     # frontend production build → apps/desktop/build
(cd apps/desktop && bun run check)     # svelte-check (run after frontend changes)

# Mobile app (Tauri Mobile thin client) — its own SvelteKit shell under apps/mobile
(cd apps/mobile && bun run check)   # type-check the mobile frontend
(cd apps/mobile && bun run build)   # build the mobile frontend → apps/mobile/build
# iOS/Android need local SDKs (Xcode / Android Studio):
#   cd apps/mobile && bun run tauri ios init    # then: bun run tauri ios build
#   cd apps/mobile && bun run tauri android init # then: bun run tauri android build

# Cloud server (dev: Postgres + MinIO + MailHog + server at :37880, hot-reload)
docker compose -f apps/server/docker-compose.dev.yml up -d --build
docker compose -f apps/server/docker-compose.dev.yml logs -f server

# Rust gates — TWO workspaces (see "Monorepo layout"). Run for whichever you touched.
# Clients workspace (desktop core + crates/* + mobile core) — one lockfile at the repo root:
cargo build  --workspace
cargo test   --workspace
cargo clippy --workspace --all-targets -- -D warnings
# Server (its own workspace):
cargo build  --manifest-path apps/server/Cargo.toml     # builds without a DB (runtime sqlx::query, no compile-time macros)
cargo test   --manifest-path apps/server/Cargo.toml
cargo clippy --manifest-path apps/server/Cargo.toml -- -D warnings

# A single Rust test (substring match on the test name)
cargo test --workspace -- send_throttle

# Regenerate the TS wire contract from the Rust source of truth (zca-types)
cargo test --manifest-path crates/zca-types/Cargo.toml --features ts

# Add a shadcn-svelte UI component
bunx shadcn-svelte@latest add <name>
```

The `zca-rust` git rev is pinned in the clients workspace's root `[workspace.dependencies]` and (separately) in `apps/server/Cargo.toml` — the two workspaces can't share the pin (see "Monorepo layout"). **Bump both together.**

## Architecture

### Data flow (the important part)

The webview **cannot make HTTP calls** — the Tauri CSP (`tauri.conf.json` `connect-src 'self' ipc:`) only permits IPC. So `src/lib/cloud.ts` is *not* an HTTP client; every function is a thin `invoke()` wrapper. The full path is:

```
Svelte UI (session.svelte.ts)
  → cloud.ts (invoke)
  → desktop core: command/cloud.rs   (reqwest HTTP client)
  → cloud server: routes.rs → sessions.rs / zalo_host.rs
  → zca-rust → Zalo
```

Realtime is the reverse: server SSE `/api/v1/realtime` → core `cloud_start_realtime` → Tauri `emit("zca-cloud://event")` → `session.svelte.ts` `listen`.

**Two parallel session paths exist in the core, and both command sets are registered in `lib.rs`:**
1. **Local** (`command/mod.rs`): `login`, `start_listening`, `send_message`, … run `zca-rust` *in-process* in the desktop core and persist to local SQLite. Realtime here is `emit("zalo://message")`.
2. **Cloud** (`command/cloud.rs`): `cloud_*` commands proxy to the server, which hosts the `zca-rust` session.

The **frontend now drives only the cloud path** (the legacy direct-IPC UI path was dropped in `8972c9c`; on launch `session.restore()` auto-reconnects the linked cloud device). The local commands remain wired and tested — don't assume they're dead code, but know the UI doesn't call them.

### Desktop core — `apps/desktop/src-tauri/src/`

Strict **forward-only layering**; a module may depend only on layers earlier in this list:

```
types → config → store → zalo → session → command
```

- **`types/`** — pure DTOs, no secrets cross IPC. `Credentials` (the `imei`+`cookie`+`userAgent` bearer triple) deliberately has no `Debug`; `IncomingMessage` / `AccountProfile` / `Contact` etc. are the non-secret event shapes.
- **`config/`** — `tracing` setup + **secret redaction** (`redact.rs` masks ~12 key patterns: cookie, imei, zpw_enk, token, …). Raw unredacted logs only with `ZCA_LOG_RAW=1`.
- **`store/`** — local SQLite (`db.rs`: accounts, credentials, threads, messages, attachments, recent_stickers). `crypto.rs` encrypts the credential blob with AES-256-GCM under a single master key kept in the **OS keychain** (`keyring`).
- **`zalo/`** — the *only* module that calls `zca-rust`. Maps the core `Credentials` DTO ↔ `zca-rust`, drives QR login (`run_qr_login`), exposes login/listen/send.
- **`session/`** — `SessionManager`: `Mutex<HashMap<AccountId, ManagedSession>>` of authenticated API handle + live listener, plus a per-account send throttle (≈800ms) to avoid spam/ban risk. Inserting a session stops the prior listener first.
- **`command/`** — the Tauri IPC boundary: validate input, resolve the session from managed state, delegate, emit only non-secret DTOs. `lib.rs:run()` builds the Tauri app, registers `SessionState` + `StoreState`, and the `invoke_handler` list.

### Cloud server — `apps/server/src/`

- **`main.rs` / `lib.rs`** — boot: load config, connect Postgres, **run migrations on startup**, restore active hosted sessions, build the axum `Router`, serve. `AppState` holds config, db pool, `HostedSessionManager`, object store, and a broadcast channel for SSE.
- **`routes.rs`** — the HTTP contract the desktop core calls, all under `/api/v1/` (+ `/health`): `auth/magic-link/{request,verify}`, `devices`, `accounts` (+ `qr/start`, `qr/:flow_id`, contacts, `send/{text,sticker,reaction,file}`), `conversations` + `/messages`, `files` (`init`, `:id`, `:id/blob`), `realtime` (SSE).
- **`auth.rs`** — email magic-link → issues a **device token**. Requests authenticate via `Authorization: Bearer <device_token>`; the token is SHA-256 hashed and looked up in `devices`. Auth is an axum `FromRequestParts` extractor (`Auth`/`AuthDevice`).
- **`sessions.rs` / `zalo_host.rs`** — server-side equivalent of the desktop `session`+`zalo` layers: runs `zca-rust` listeners, persists incoming messages/reactions/undos (encrypted) to Postgres, applies the same send throttle.
- **`crypto.rs`** — per-user `data_key` (random 32 bytes) **wrapped twice**: once by the user's `recovery_key` (client-held; the only way to link a new device) and once by the server's `ZCA_CLOUD_MASTER_KEY`. HKDF-SHA256 for domain separation, AES-256-GCM for sealing, Argon2 for the recovery-key hash. Message bodies, rich payloads, and per-file keys are sealed with the data_key.
- **`storage.rs`** — S3 / `object_store` media mirroring (in-memory fallback if no endpoint). Blobs are encrypted before upload.
- **`migrations/`** — schema: `users`, `magic_links`, `devices`, `cloud_accounts`, `conversations`, `messages`, `files`, `hosted_sessions`, `audit_events`.
- Config is all `ZCA_CLOUD_*` env (see `server/README.md`). In dev, `ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS=1` returns the login code in the API and mail goes to MailHog at `:37885`.

### Frontend — `src/`

- One page: `routes/+page.svelte` gates on `session.loggedIn` and renders the panes (`RailNav` account switcher · `ConversationList`/`ContactList` · `ChatPane`, with `QrLoginScreen`/`SettingsDialog`/`StickerPicker` overlays). `+layout.ts` sets `ssr=false`.
- **`lib/session.svelte.ts`** is the state coordinator — Svelte 5 runes (`$state`/`$derived`). Multi-account: the active account is mirrored into top-level reactive fields while background accounts live in a `buckets` Map; `switchAccount()` swaps them. Owns the realtime listener and exponential-backoff reconnect.
- **`lib/cloud.ts`** = invoke wrappers (see Data flow). `lib/types.ts` = display-only types (no secrets). `lib/theme.svelte.ts` = light/dark, `lib/log.ts` forwards UI logs to the core via `log_from_ui`.
- shadcn-svelte components in `lib/components/ui/`; compose classes with `cn()` from `lib/utils.ts`; theme tokens in `src/app.css`.

## Hard rules (see `AGENTS.md`)

- **Secrets**: the Zalo `imei`+`cookie`+`userAgent` triple and the cloud `data_key`/`recovery_key`/device tokens are bearer credentials. Never log, echo, serialize to the UI, or commit them. `.gitignore` blocks `*.cred.json` and `cookies.json`; keep redaction working.
- **Layering**: respect the forward-only order in the core; don't add/rename a layer without a rationale in the PR. Don't add native-binding deps without discussion (the stack is deliberately pure-Rust / rustls).
- **Posture**: unofficial API, personal use — no spam-like or bulk-automation features (they get users banned). The send throttle exists for this reason.
- **Verify before done**: run the build/test/clippy gates above for any crate you touched, and `bun run check` for frontend changes.
- Commits are signed off (`git commit -s`); UI copy is plain Vietnamese, no dev/SaaS jargon.
