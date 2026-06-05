# zca-desktop

Cross-platform **Zalo desktop client** built with **Tauri v2 + Rust**, powered by the
[`zca-rust`](https://github.com/tuanle96/zca-rust) unofficial Zalo API client.

![zca-desktop desktop app screenshot](docs/readme-assets/zca-desktop-demo.png)

- **Multi-account**: several accounts logged in at the same time, each with its own realtime listener.
- **Multi-device**: coexists with the user's other Zalo devices (phone/web) without forcing a logout.

> ⚠️ **Unofficial. Not affiliated with Zalo / VNG.** Personal-use tool — **use at your
> own risk.** Using an unofficial client can get your Zalo account **rate-limited,
> suspended, or permanently banned**, and may violate Zalo's Terms of Service. Read the
> full [DISCLAIMER](./DISCLAIMER.md) before using.

## Stack
- **Core**: Rust (Tauri v2) — hosts a `SessionManager` of `zca-rust` `API` + `Listener` sessions.
- **UI**: SvelteKit / Svelte 5 webview frontend, talks to the core via Tauri commands + events.
- **Cloud backend** (`server/`): Rust (axum + sqlx) host for email magic-link sign-in, server-hosted Zalo accounts, and an encrypted message/media store. The current login flow expects a reachable backend — see [`server/README.md`](./server/README.md).
- **Auth**: link this device to a cloud account via an email magic-link, then add Zalo accounts by QR. Session secrets are encrypted at rest — in the OS keychain on the desktop core, and under per-user keys on the server.

## Quick start
Prerequisites: [Rust](https://rustup.rs), [bun](https://bun.sh), and the
[Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
# 1. Install frontend deps
bun install

# 2. Start the cloud backend (Postgres + MinIO + MailHog + the server at :37880)
docker compose -f server/docker-compose.dev.yml up -d --build

# 3. Run the desktop app (Vite + the Tauri shell)
bun run tauri dev
```

The current sign-in flow needs the backend from step 2. See
[`server/README.md`](./server/README.md) to run or deploy it standalone.

## Development
See [CONTRIBUTING.md](./CONTRIBUTING.md) for the layer architecture, commands, and PR
checklist. The project is developed with the
[`agent-harness-kit`](https://github.com/tuanle96/agent-harness-kit) workflow, but you
do **not** need it to build or contribute a normal fix.

## Operational docs
- [Architecture](./docs/ARCHITECTURE.md)
- [Credential handling](./docs/CREDENTIALS.md)
- [Privacy and data handling](./docs/PRIVACY.md)
- [Deployment checklist](./docs/DEPLOYMENT.md)
- [Threat model](./docs/THREAT_MODEL.md)

## Status
Early but functional: email magic-link sign-in via the cloud backend, multi-account
session management, QR account linking, encrypted credential/media storage, SQLite
history restore, contacts/groups, settings, and text/sticker/reaction/quote/link/undo
messaging. Planned work includes richer attachment rendering, deeper
device-coexistence validation, and signed app packaging.

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
