# ADR 0005 — Local persistence: SQLite database + encrypted credential store

- **Status:** accepted
- **Date:** 2026-06-02
- **Deciders:** project owner
- **Related:** ADR-0003 (Rust core layering), ADR-0004 (credential lifecycle &
  imei strategy); supersedes the plaintext-free intent of features
  `secure-cred-store`, `message-cache`, `session-restore`

## Context

Two product needs converge on local persistence:

1. **Session must survive restart.** Today the credential triple
   (`imei + cookie + user_agent`) lives only in process memory
   (`command::ListenerState`). Closing the app drops it, so every launch falls
   back to the QR screen — the standing UX complaint.
2. **Messages/files must not be lost.** Zalo is known to lose message/file
   history. A core value of this client is keeping a durable local copy of every
   conversation, message, and attachment that the realtime listener observes.

The app is multi-account by design (ADR-0004), so persistence must be keyed by
account. The `store` layer already exists in the ADR-0003 layer order
(`types → config → store → zalo → session → command`) but has no implementation
yet.

A hard constraint from ADR-0004 / risk r4: the credential triple is a bearer
token and must never be written to disk in plaintext. A naive "save the session
row in SQLite" would violate that.

## Decision

### 1. SQLite is the local database (`rusqlite`, bundled)

Use `rusqlite` with the `bundled` feature (compiles a pinned SQLite in-tree — no
dependency on a system SQLite, no extra native lib to install). The database
file lives in the OS app-data dir: `<app-data>/zca-desktop/zca.db`.

The `store` layer owns:
- schema creation + migrations (a `schema_version` pragma/table),
- a single connection guarded by a `Mutex` (or a small pool), exposed to higher
  layers as typed repository functions — never raw SQL above `store`.

### 2. Encryption-at-rest for credentials: master key in OS keychain

Credentials are NOT stored in plaintext, even inside SQLite:

- A random 32-byte **master key** is generated once and stored as the ONLY
  secret in the OS keychain (`keyring` v3: `apple-native` on macOS,
  `windows-native` on Windows, `sync-secret-service` on Linux), under a fixed
  service/account name.
- The credential triple is serialized, encrypted with **AES-256-GCM**
  (`aes-gcm`, pure-Rust RustCrypto) using that master key and a fresh random
  nonce, and the `nonce || ciphertext` blob is stored in the SQLite
  `credentials` table keyed by `account_id`.
- On load, the master key is read from the keychain and used to decrypt.

This keeps the keychain footprint minimal (one key, not N credentials) while
ensuring a leaked `zca.db` file exposes no usable session. It satisfies the
"never plaintext on disk" rule of `secure-cred-store` and the "store the session
so it survives restart" requirement together.

### 3. Schema (initial)

```
accounts(account_id PK, display_name, avatar, added_at, last_login_at, state)
credentials(account_id PK -> accounts, enc_blob BLOB, updated_at)
threads(account_id, thread_id, kind, title, avatar, last_at, unread,
        PRIMARY KEY(account_id, thread_id))
messages(account_id, thread_id, msg_id, from_id, from_name, body, outgoing,
         kind, ts, PRIMARY KEY(account_id, msg_id))
attachments(account_id, msg_id, kind, url, local_path, filename, size, meta)
```

- `accounts.state` tracks the ADR-0004 lifecycle (`active` / `reauth-needed`).
- Messages/attachments are append-only mirrors of what the listener observes;
  this is the anti-message-loss store. Message bodies are user data on the
  user's own machine and are stored as-is (DB-level encryption may be layered
  later; durability is the immediate goal).

### 4. Session restore on startup

On launch the app reads the `accounts` table, loads + decrypts each credential,
and re-logs-in/listens per account (reusing the existing `login_and_listen`
path). A credential rejected as expired flips `accounts.state` to
`reauth-needed` and surfaces a re-scan prompt for THAT account without
disturbing the others (ADR-0004 lifecycle).

### 5. Layering

- All DB + keychain + crypto code lives in `store` (and `config` for the db
  path/env). Higher layers call typed `store` functions; `rusqlite`,
  `keyring`, and `aes-gcm` types never leak above `store`.
- `command` orchestrates: after a successful QR/cookie login it persists the
  account + encrypted credential; on startup it asks `store` for saved accounts
  and drives restore.

## Consequences

Positive
- Session survives restart; multi-account state is durable and keyed by account.
- A durable local copy of messages/attachments directly addresses Zalo's
  message-loss pain point.
- Credentials are encrypted at rest; a leaked DB file is not a session leak.
- One secret in the keychain (the master key) instead of N credentials.

Negative
- New dependencies with native/bundled code: `rusqlite` (bundled SQLite C),
  `aes-gcm`, `keyring`. This is exactly the kind of change ADR-0003/AGENTS.md
  says needs an ADR — hence this record. `rusqlite` compiles SQLite from source
  (longer cold build); acceptable for a desktop app.
- Losing the keychain master key (e.g. OS reinstall) makes stored credentials
  undecryptable → those accounts need a fresh QR scan. Message history in
  SQLite remains readable (not encrypted with that key in this iteration).
- DB schema migrations are now a maintenance surface.

## Alternatives considered

- **Store the credential triple as plaintext in SQLite / a JSON file.**
  Rejected: violates ADR-0004 / risk r4 (bearer token on disk).
- **Store each credential directly in the OS keychain (no SQLite for secrets).**
  Viable and simpler for secrets, but it does not give us the message/attachment
  store we need anyway, and N keychain entries is more prompts/management than
  one master key. We still use the keychain — for the single master key.
- **SQLCipher (whole-DB encryption).** Rejected for now: heavier build, and the
  immediate priority is durability of messages + encryption of the
  high-value secret (credentials). Whole-DB encryption can be layered later
  without changing the repository API.
- **`sqlx` instead of `rusqlite`.** Rejected: `sqlx` async + compile-time query
  checking adds a build-time DB and more ceremony than this local single-file
  store needs; `rusqlite` bundled is simpler and dependency-light.

## Out of scope

- Whole-database encryption (SQLCipher) — future ADR if required.
- Backfilling history that predates first login — upstream offers no
  recent-conversations / 1:1 history API (only group history), so the mirror
  starts from what the listener observes after first run.
- Cross-install sync of the database — remains the ADR-gated Phase 5 relay.
