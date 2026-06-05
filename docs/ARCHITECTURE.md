# Architecture

zca-desktop is a Tauri v2 application with a Rust core, SvelteKit frontend, and
an optional Rust cloud backend.

## Desktop core

The desktop Rust core lives in `apps/desktop/src-tauri/src` and follows this
forward-only layer order:

```text
types -> config -> store -> zalo -> session -> command
```

- `types`: DTOs and non-secret data structures.
- `config`: runtime config, logging, and redaction.
- `store`: SQLite persistence and encrypted credential storage.
- `zalo`: adapter around the unofficial `zca-rust` API.
- `session`: in-memory account/session manager and listener ownership.
- `command`: Tauri IPC boundary exposed to the Svelte webview.

The webview must not receive Zalo bearer credentials. Tauri commands should
return non-secret DTOs, IDs, status, and event payloads only.

## Cloud backend

The cloud backend lives in `apps/server` and is a separate Cargo workspace. It is
split from the desktop workspace because the desktop and server use different
SQLite-linked dependency graphs.

The backend provides:

- Email magic-link authentication.
- Device tokens for linked clients.
- Server-hosted Zalo account sessions.
- Encrypted message metadata and media/object storage.
- Server-sent events for per-user realtime updates.

Postgres is the source of truth for cloud state. S3-compatible object storage is
used for mirrored media in deployments that enable it.

## Shared contracts

The Rust crate `crates/zca-types` is the single source for shared API DTOs. Its
test code generates TypeScript into `packages/types/src/generated/contract.ts`.
Run the contract generation check before changing public API shapes:

```bash
cargo test --manifest-path crates/zca-types/Cargo.toml --features ts
git diff --exit-code -- packages/types/src/generated
```

## Frontend

The desktop frontend lives in `apps/desktop/src`. It calls the core via Tauri
`invoke` and listens for Tauri events. Shared cloud-client wrappers live in
`packages/core-client` so desktop and mobile can use the same command contract.

## Mobile

The mobile app in `apps/mobile` is a thin cloud client. It reuses the shared
frontend contract and stores the cloud device token in the mobile keychain layer.
