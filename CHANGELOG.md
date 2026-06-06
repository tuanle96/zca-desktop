# Changelog

All notable zca-desktop release changes are documented here.

## Unreleased

### Schema Compatibility

- No pending schema compatibility changes.

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
