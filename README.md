# zca-desktop

Cross-platform **Zalo desktop client** built with **Tauri v2 + Rust**, powered by the
[`zca-rust`](https://github.com/tuanle96/zca-rust) unofficial Zalo API client.

- **Multi-account**: several accounts logged in at the same time, each with its own realtime listener.
- **Multi-device**: coexists with the user's other Zalo devices (phone/web) without forcing a logout.

> ⚠️ Unofficial. Not affiliated with Zalo / VNG. Personal-use tool — use at your own risk.

## Stack
- **Core**: Rust (Tauri v2) — hosts a `SessionManager` of `zca-rust` `API` + `Listener` sessions.
- **UI**: webview frontend, talks to core via Tauri commands + events.
- **Auth**: credentials imported from the ZaloDataExtractor browser export (`imei` + `cookie` + `userAgent`), stored in the OS keychain.

## Dev control center: agent-harness-kit
This repo uses [`agent-harness-kit`](https://github.com/tuanle96/agent-harness-kit) (Kiro runtime, Rust adapter) as the
model + harness control center.
- Roadmap / backlog: `.harness/feature_list.json`
- Phases, scope, risks, decisions: `.harness/project/state.json`
- Model routing: `.harness/config.json#models` (Opus=implementation, Sonnet=review, Haiku=explore)
- Pick the next unit of work with the `/add-feature` skill.

## Status
Phase 0 (research + harness bootstrap) complete. Phase 1 (Tauri scaffold) is next.
