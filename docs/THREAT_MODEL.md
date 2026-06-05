# Threat Model

This document lists the main security boundaries and risks for zca-desktop.

## Assets

- Zalo credential sets: `imei`, cookies, `userAgent`.
- Cloud device tokens.
- Magic-link tokens.
- Recovery keys and wrapped data keys.
- Message content, contact data, and media.
- Cloud object storage credentials and database credentials.
- Cloudflare tunnel credentials.

## Trust boundaries

- Tauri webview to Rust core IPC.
- Desktop core to OS keychain and SQLite.
- Desktop/mobile client to cloud backend.
- Cloud backend to Postgres and object storage.
- Cloud backend to SMTP/webhook delivery.
- Cloud backend and desktop core to unofficial Zalo endpoints.

## Primary risks

- Credential leakage through Git, logs, screenshots, issues, or crash reports.
- Webview code accidentally receiving raw Zalo credentials.
- Magic-link token replay or brute forcing.
- Device token theft from client storage.
- Server-hosted account compromise if the cloud master key leaks.
- Public exposure of dev-only services such as MailHog or MinIO.
- Account bans or lockouts caused by unofficial API behavior.

## Current mitigations

- Credential exports are gitignored.
- Desktop credentials are encrypted before SQLite persistence.
- Cloud device tokens are stored in keychain-backed storage and represented in
  webview calls by a sentinel when possible.
- Magic links are consumed atomically and are single-use.
- Server master key is required and rejects the built-in placeholder.
- Dev magic-token return is rejected on non-loopback binds.
- CORS emits no permissive browser origin by default.
- Realtime events are scoped to the authenticated user.
- Raw desktop API captures are redacted by default.

## Residual risk

This is an unofficial client for private endpoints. Zalo can change behavior,
detect sessions, revoke cookies, rate-limit, suspend, or ban accounts. Users
should use test accounts where possible and avoid bulk or spam-like behavior.
