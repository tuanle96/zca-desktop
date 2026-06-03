# ADR 0006 — SaaS session-host backend and confidential-at-rest storage

- **Status:** accepted
- **Date:** 2026-06-03
- **Deciders:** project owner
- **Related:** ADR-0003, ADR-0004, ADR-0005

## Context

The local desktop app already supports multiple Zalo accounts, local encrypted
credential storage, and local message history. The next product direction is a
SaaS posture: one hosted service stores many users' accounts, messages, and
files so a user can sign in from several desktop installs without repeating
Zalo QR login on every device.

The chosen v1 model is **session host**: the backend runs the `zca-rust`
sessions. That changes the trust boundary. A server-hosted worker must decrypt
the Zalo credential and observe message/file plaintext at runtime to login,
listen, and send. Therefore this design cannot honestly claim true E2E
encryption against the server/operator.

## Decision

Add a top-level Rust backend crate (`server/`) with Postgres and S3-compatible
object storage. The backend owns SaaS users, devices, cloud Zalo accounts,
hosted sessions, encrypted-at-rest messages, and encrypted file metadata/blobs.

Security posture:

- Call the model **confidential-at-rest**, not true E2E.
- Postgres and object storage store ciphertext for Zalo credentials, message
  bodies, and file keys/blobs.
- The backend process may hold plaintext in memory only while handling login,
  realtime events, sends, and file transfer.
- Logs must only contain non-secret identifiers, counts, sizes, hashes, and
  state transitions; never credential values, message bodies, recovery keys, or
  file contents.

User/device model:

- Users authenticate with email magic links.
- Devices are registered to a user and receive revocable bearer tokens.
- A recovery key protects the user's data key. The server stores only a
  password-hash verifier for the recovery key plus the data key wrapped by a
  key derived from that recovery key.
- The recovery key is shown once at first setup; losing it means device
  recovery cannot unwrap old encrypted data.

Hosted session model:

- One backend session worker is managed per cloud Zalo account.
- Backend session throttling preserves the local app's per-account send pacing.
- Desktop cloud mode talks to the backend API and realtime stream. Local mode
  remains available and keeps using Tauri commands against the local store.

## Consequences

Positive:

- A user can access the same hosted account/messages/files from multiple
  desktop installs after SaaS sign-in and device registration.
- A leaked database/object bucket does not expose credential, message, or file
  plaintext.
- The local desktop architecture remains intact while cloud mode is developed.

Negative:

- Backend operators and a compromised backend process are in the trust boundary.
  This is not true E2E.
- Recovery-key UX and device revocation become product-critical surfaces.
- Running `zca-rust` centrally concentrates unofficial-API/ban risk; rate
  limiting and live evidence are mandatory before production claims.

## Alternatives considered

- **True E2E sync relay.** Rejected for this v1 because the user chose
  session-host behavior. True server-blind E2E requires desktop/device-hosted
  Zalo sessions and a ciphertext-only relay.
- **Store plaintext in Postgres/S3 and rely on disk encryption.** Rejected:
  database/object leaks are realistic SaaS risks and would expose bearer
  credentials and user content.
- **Email/password first.** Rejected for v1 in favor of magic links to avoid
  password reset/storage surface while the backend is still hardening.

## Out of scope

- Production email provider, object-store bucket provisioning, and deploy
  automation.
- True server-blind E2E.
- Claiming live Zalo session-host completeness before live account evidence is
  captured through the hosted worker path.
