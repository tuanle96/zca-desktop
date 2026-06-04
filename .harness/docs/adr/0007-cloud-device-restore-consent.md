# ADR 0007 - Cloud device restore consent

- **Status:** accepted
- **Date:** 2026-06-04
- **Deciders:** project owner

## Context

Cloud mode stores Zalo credentials in the hosted session backend. The desktop app still stores a SaaS device token in the OS keychain so the registered device can call the backend. Automatically reading that token during Tauri startup can trigger a macOS keychain prompt before the user has chosen to reconnect, which looks like local Zalo credential restore and conflicts with the cloud-only trust boundary.

## Decision

Cloud device token restore is explicit user intent, not automatic startup behavior.

- Startup stops at the login gate after lightweight local state initialization.
- The UI may remember a non-secret marker that a cloud device was previously linked.
- Reading the keychain-backed SaaS device token happens only when the user chooses to continue with the linked cloud device or after a fresh magic-link/device registration response.
- User-facing Vietnamese copy says cloud device connection, not local session restore.

## Consequences

Positive: macOS keychain prompts happen at a user-initiated moment and are easier to explain.

Positive: Zalo credentials remain hosted/backend-owned; the desktop webview still sees only the non-secret `__keychain__` sentinel.

Negative: opening the app no longer auto-enters the chat shell without one explicit click.

## Alternatives considered

- Auto-restore on every startup: rejected because it can show a keychain prompt before user intent is clear.
- Store the SaaS device token in localStorage: rejected because it weakens bearer-token storage.
- Remove device restore entirely: rejected because registered-device reuse is still required for the cloud SaaS model.
