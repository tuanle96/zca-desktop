# ADR 0003 — Rust core layering for the Tauri app

- **Status:** accepted
- **Date:** 2026-06-01
- **Deciders:** project owner
- **Supersedes:** the generic layer order declared in ADR-0001

## Context

ADR-0001 adopted the kit's generic layer order
`types → config → repo → service → runtime → ui`. That naming assumes a
TypeScript web/API app. zca-desktop is a Tauri v2 desktop app: a Rust core
(`src-tauri/src/`) hosting multiple concurrent `zca-rust` sessions, plus a
separate SvelteKit frontend (`src/`). The generic names (`repo`, `service`,
`runtime`) do not describe the real responsibilities, and `ui` does not even
live under the Rust root.

## Decision

Adopt a domain-specific, forward-only layer order for the Rust core, set in
`.harness/config.json#domains[0]` (`root: src-tauri/src`):

```
types → config → store → zalo → session → command
```

- `types` — pure data shapes (AccountId, Credentials, ThreadView, AppEvent).
- `config` — app configuration, paths, constants.
- `store` — persistence + secrets: OS keychain credential store + SQLite cache.
- `zalo` — zca-rust integration: wraps `Zalo::new().login()` and bridges the WebSocket `Listener`.
- `session` — `SessionManager`: owns N concurrent per-account `zalo` sessions and their lifecycle.
- `command` — Tauri command handlers + event emit; the boundary the UI calls.

The SvelteKit frontend (`src/`) is the `ui` and is a separate unit; it depends
on the core only through Tauri `invoke`/`listen` against `command/`.

Structural enforcement stays disabled (`structuralTest.engine: none`) until
real Rust source exists under these layers, at which point the Rust adapter is
wired and this order becomes mechanically enforced.

## Consequences

Positive
- Layer names match real responsibilities; reviews and `/inspect-module` are clearer.
- The dependency DAG (`command` → `session` → `zalo` → `store` → `config` → `types`) is acyclic and matches the multi-account design.

Negative
- Diverges from the kit's shipped TypeScript governance rules (`no-db-in-ui`, etc.), which reference `ui`/`repo`; those rules are inert here and would need Rust equivalents if added later.
- architecture.md, golden-principles #1, and the steering file had to be updated to match (done in this change).

## Alternatives considered
- **Keep the generic `repo/service/runtime/ui` names.** Rejected: misleading for a Tauri desktop app; `ui` lives outside the Rust root.
- **Single flat module.** Rejected: loses the forward-only guarantee that keeps the multi-account core refactorable.
