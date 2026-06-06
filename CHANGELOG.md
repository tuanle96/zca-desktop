# Changelog

All notable zca-desktop release changes are documented here.

## Unreleased

### Schema Compatibility

- No pending schema compatibility changes.

## v0.1.6 - 2026-06-06

Magic-link duplicate callback hotfix.

### Fixed

- Prevented the browser magic-link landing page from delivering the same token more than once while opening the app.
- Ignored duplicate already-verified magic-link callbacks in the desktop session state.
- Moved the login gate to the "add Zalo account" step as soon as the cloud device token is valid, even before a Zalo account exists.

## v0.1.5 - 2026-06-06

Cloud endpoint hotfix.

### Fixed

- Fixed production builds falling back to `http://127.0.0.1:37880` when `PUBLIC_ZCA_CLOUD_BASE_URL` was present during build/runtime.
- Migrated stale `zca.cloud.baseUrl` values in browser storage from loopback hosts back to `https://zca.tuanle.dev`.

## v0.1.4 - 2026-06-06

Startup crash hotfix.

### Fixed

- Fixed an immediate macOS startup panic caused by starting the magic-link callback listener with `tokio::spawn` before a Tokio reactor exists in Tauri setup.

## v0.1.3 - 2026-06-06

Cloud magic-link callback and production endpoint hardening release.

### Added

- Browser-first magic-link landing flow that opens the desktop app through a local callback listener, with `zca://open` used only to wake the app.
- Local callback validation for cloud magic links, including loopback listener handling and origin checks against the configured cloud API.

### Changed

- Desktop cloud defaults and persisted cloud server settings now normalize to `https://zca.tuanle.dev` instead of reusing localhost values.
- Advanced cloud server settings reject loopback hosts such as `localhost` and `127.0.0.1`, falling back to the production cloud endpoint.
- Version bumped to `0.1.3` for the next GitHub/Homebrew/updater release.

## v0.1.2 - 2026-06-06

In-app updater release.

### Added

- Tauri updater plugin wiring for in-app update checks, download/install, and relaunch from the Settings About tab.
- Static GitHub Release updater manifest at `latest.json` for signed macOS updater artifacts.

### Changed

- Version bumped to `0.1.2` so users can move from the first Homebrew Cask release into an updater-enabled app.

## v0.1.1 - 2026-06-06

Production cloud endpoint and email delivery release.

### Changed

- Desktop and mobile cloud defaults now point to `https://zca.tuanle.dev`, with `PUBLIC_ZCA_CLOUD_BASE_URL` still available as an override.
- Desktop Settings now reports app version `0.1.1`.
- Cloudflared deployment docs/config now target the production API hostname instead of localhost defaults.

### Added

- Resend-backed magic-link email delivery for the cloud server via `ZCA_CLOUD_RESEND_API_KEY`.
- Production environment docs for the Resend sender `ZCA Cloud <no-reply@zca.tuanle.dev>`.
- Release note artifact for the notarized macOS universal DMG.
- Homebrew Cask definition for installing the notarized macOS DMG with `brew install --cask zca-desktop`.

### Verified

- Production API magic-link request to `https://zca.tuanle.dev/api/v1/auth/magic-link/request` returned `sent=true`.
- macOS universal DMG was Developer ID signed, notarized by Apple, stapled, and accepted by Gatekeeper.

### Known Gaps

- Harness readiness is still blocked by the advisor-proof artifact issue in the current agent-harness runtime; code/test/release checks were run separately.

## v0.1.0 - 2026-06-06

Initial public desktop release for personal, noncommercial use.

### Added

- Tauri v2 + Rust + SvelteKit desktop client for local Zalo chat.
- QR login with non-secret progress events and encrypted credential persistence.
- Multi-account session management with per-account realtime listeners.
- Account switcher, saved account restore, logout, and reauth-needed state.
- Local SQLite storage for accounts, threads, messages, rich metadata, attachment metadata, and recent stickers.
- Rich chat support for text, quotes, stickers, sticker search/recent packs, reactions, link previews, and recalled/deleted state.
- Friend/contact and group metadata loading with thread identity backfill.
- Optional self-hosted Rust cloud backend for magic-link device auth, hosted Zalo sessions, encrypted sync state, media mirroring, and SSE realtime.
- macOS universal DMG for `x86_64` and `arm64`, signed with Developer ID and notarized by Apple.

### Verified

- `npm run harness:doctor`
- `npm run harness:check`
- `bun run check`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`
- `npm run harness:readiness`
- `codesign` verification for the DMG and mounted app.
- `xcrun stapler validate` for the notarized DMG.
- `spctl` Gatekeeper assessment for the DMG and mounted app.

### Known Gaps

- Local desktop attachment sending remains a roadmap item.
- Hosted attachment delivery is wired but still needs more live hardening for some media paths.
- Windows and Linux signed installers are not published in this release.
- This is an unofficial Zalo client and is not affiliated with Zalo or VNG.
