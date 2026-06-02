# ADR 0004 — Credential lifecycle and imei strategy

- **Status:** accepted
- **Date:** 2026-06-02
- **Deciders:** project owner
- **Related:** ADR-0003 (Rust core layering); features `qr-login`,
  `secure-cred-store`, `session-restore`, `device-coexistence`

## Context

Today the app authenticates by reading a pre-populated `.zalo-cred.json`
(`dev-session-loader`, a dev affordance). The real product needs an
interactive login that a normal user can complete without ever touching a
browser cookie export, and it must support two postures the project owner has
committed to (`project/state.json`):

- **many accounts** logged in at once, and
- **the same account** running on **several installs/devices** at once,
  coexisting with the user's phone and Zalo PC/Web.

The pinned `zca-rust` rev (`08698e1`) already ships a complete QR login flow
(`API::login_qr`, `src/apis/login_qr.rs`) that emits `QRCodeGenerated`
(base64 PNG + `code` + `token`), `QRCodeScanned`, `QRCodeDeclined`, and
`QRCodeExpired`. So the network mechanics exist; what is undecided is the
**credential lifecycle**: what a successful QR login produces, how a session
is made reusable across restarts, and how device identity is handled.

Two facts force the decisions below:

1. **`Zalo::login()` requires `imei` + `cookie` + `user_agent`.** A reusable
   session is exactly that triple. Cookie-import login already provides all
   three.
2. **The QR flow does not currently yield an `imei`.** `LoginQRResult` returns
   only `{ user_info, cookie_jar }`. The `LoginQREvent::GotLoginInfo
   { cookies, imei, user_agent }` variant is declared but **never emitted** in
   the Rust port. So after a QR scan we have cookies + display name/avatar, but
   no device identity to pair with them.

`imei` is the device identity Zalo uses to distinguish one PC client from
another. If it is unstable (regenerated every launch), Zalo sees a new device
on every start — a re-auth/challenge magnet and a logout risk (`state.json`
risk r2/r3). If it is shared across machines, multiple installs look like the
**same** device fighting over one session — fragile and easy to invalidate.

## Decision

### 1. The canonical credential is the triple `{ imei, cookie, user_agent }`

All login paths converge on a single `types::Credentials`:

- **Cookie/JSON import** (existing) supplies the triple directly.
- **QR login** (new) supplies `cookie` (from the QR cookie jar) + `user_agent`
  (the value we pass into the flow) and pairs them with an `imei` we generate
  and own (decision #2).

Everything downstream — `zalo::login()`, `SessionManager`, the `Listener`,
send/list — consumes the triple and needs no QR-specific code path.

### 2. We generate and own a stable per-account `imei`

- On first login for a never-seen account, the **core** generates a random
  `imei` (UUID v4 string) once.
- That `imei` is persisted alongside the cookies and reused for every
  subsequent login of that account on this install.
- `imei` lives in the `store` layer (decision #4); it is treated as a bearer
  secret like the cookies and never crosses into the webview.

This makes each account look like one stable PC device to Zalo, which is the
posture that minimizes re-auth challenges and supports clean coexistence.

### 3. `imei` is per-(account, install) — never shared across devices

For "same account on several devices", **each install generates its own
`imei` and performs its own QR scan**. We do not copy the
`{ imei, cookie, user_agent }` triple between machines (no session cloning).
Distinct imeis are what let two of our installs coexist the way Zalo PC and
Zalo Web coexist. Verifying this empirically is the `device-coexistence`
feature; this ADR only fixes the identity model it relies on.

Any future "sync my reads/history across my own installs" capability syncs
**application state**, not credentials, and remains the ADR-gated Phase 5
relay (`state.json` decision d6). Credentials stay device-local.

### 4. Credentials are stored in the OS keychain, keyed by account

- The `store` layer owns a keychain-backed credential store (crate `keyring`)
  that saves/loads/deletes the full triple per `AccountId`
  (the `secure-cred-store` feature).
- No plaintext credential file is a supported production path. `.zalo-cred.json`
  stays a dev-only affordance behind `dev-session-loader` and is gitignored.
- Credential values never serialize back across the Tauri IPC boundary; the UI
  only ever receives non-secret DTOs (`AccountProfile`, `CredentialSummary`,
  and QR *display* events — image/code/status, never the resulting triple).

### 5. Lifecycle states are explicit

An account credential moves through:

```
none ──QR scan/confirm──▶ active ──cookie expiry / 401──▶ reauth-needed
   ▲                                                          │
   └──────────────────  QR re-scan (same imei)  ◀─────────────┘
```

- **active** — triple present and a live session exists.
- **reauth-needed** — cookies rejected/expired; the session for *this* account
  is marked for re-auth and surfaced in the UI without disturbing other
  accounts. Re-auth reuses the stored `imei` (decision #2) and only refreshes
  cookies via a new QR scan.
- Deleting an account removes its triple from the keychain.

## Consequences

Positive

- One credential shape for every login method; `SessionManager` and the
  listener are unaffected by how a session was obtained.
- Stable per-account `imei` reduces forced re-auth and gives a coherent story
  for multi-device coexistence.
- Secrets (cookies + imei) stay in the core and the OS keychain, never in the
  webview or a plaintext file — closes risk r4 and aligns with the existing
  "token never enters the webview" decision.
- QR login needs **no new layer and no new dependency** beyond a UUID source
  for `imei`; it slots into the existing `zalo → command` path.

Negative

- We must implement the imei-generation + persistence ourselves because the
  upstream QR flow does not emit `GotLoginInfo`. Tracked as part of `qr-login`;
  if upstream later emits a real device `imei`, we revisit which value wins
  (a follow-up ADR).
- A per-install `imei` means re-installing the app (or clearing the keychain)
  forces a fresh QR scan for each account. Accepted: this is the correct
  security posture, not a bug.
- Pulling `secure-cred-store` forward (so QR-issued credentials have a home)
  reorders the backlog relative to the original phase numbering.

## Alternatives considered

- **Derive `imei` from the cookies / reuse a constant.** Rejected: a shared or
  derived imei collapses the per-device identity that multi-device coexistence
  depends on, and a constant makes every install look like one device.
- **Keep credentials in a plaintext file in the app data dir.** Rejected:
  cookies + imei are bearer tokens (risk r4); plaintext on disk is the failure
  mode the keychain decision exists to prevent.
- **Pass the QR-issued triple to the webview and store it in the frontend.**
  Rejected: violates the standing "token never enters the webview" decision;
  the DOM is the wrong trust boundary for bearer tokens.
- **Patch `zca-rust` to emit `GotLoginInfo` and rely on an upstream imei.**
  Deferred: larger change to a pinned dependency; generating our own imei is
  smaller, fully under our control, and matches how the upstream zca-js clients
  treat device identity. Revisit if/when upstream emits a real device imei.

## Out of scope

- Empirical verification that N installs of the same account coexist without
  forced logout — that is the `device-coexistence` feature's live evidence.
- The QR modal UX details (countdown, auto-refresh, scanned-avatar preview) —
  specified in the `qr-login` task contract, not here.
