# zca-desktop

Cross-platform **Zalo desktop client** built with **Tauri v2 + Rust**, powered by the
[`zca-rust`](https://github.com/tuanle96/zca-rust) unofficial Zalo API client.

- **Multi-account**: several accounts logged in at the same time, each with its own realtime listener.
- **Multi-device**: coexists with the user's other Zalo devices (phone/web) without forcing a logout.

> ⚠️ **Unofficial. Not affiliated with Zalo / VNG.** Personal-use tool — **use at your
> own risk.** Using an unofficial client can get your Zalo account **rate-limited,
> suspended, or permanently banned**, and may violate Zalo's Terms of Service. Read the
> full [DISCLAIMER](./DISCLAIMER.md) before using.

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
MVP vertical slice is implemented and harness-tracked: QR login, multi-account
session management, keychain credential storage, SQLite history restore,
contacts/groups, settings, text/sticker/reaction/quote/link/undo messaging.
Remaining planned work is attachment upload/rendering, deeper device-coexistence
validation, optional sync relay research, and signed app packaging.

## Contributing
Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) first.

In short:
- Every contributor must agree to the [Contributor License Agreement](./CLA.md) and
  sign off their commits (`git commit -s`).
- Be respectful — see the [Code of Conduct](./CODE_OF_CONDUCT.md).
- No spam-like or bulk-automation features (ban risk for users).
- Never commit credentials or secrets.

Found a security or credential-handling issue? Report it privately — see
[SECURITY.md](./SECURITY.md). Do not open a public issue.

## License
zca-desktop is licensed under the **[PolyForm Noncommercial License 1.0.0](./LICENSE)**.

- ✅ **Free** for personal, hobby, educational, research, and other **noncommercial** use.
- ❌ **Commercial use is not permitted** under this license.

If you need a commercial license, contact the maintainer. See the full terms in
[LICENSE](./LICENSE), the usage caveats in [DISCLAIMER.md](./DISCLAIMER.md), and the
[PolyForm FAQ](https://polyformproject.org/licenses/) for background.
