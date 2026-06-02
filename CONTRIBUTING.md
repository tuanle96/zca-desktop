# Contributing to zca-desktop

Thanks for taking the time to contribute. This project is a personal,
**noncommercial** tool (see [LICENSE](./LICENSE)) and welcomes bug reports, fixes,
and improvements that respect that posture.

Before you start, please read the [DISCLAIMER](./DISCLAIMER.md) — this is an
unofficial Zalo client and carries account-ban risk.

## Ground rules

- **Be respectful.** All interaction is governed by our
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- **Noncommercial only.** Contributions are licensed under the
  [PolyForm Noncommercial License 1.0.0](./LICENSE). Do not submit code you intend
  to use commercially or that is encumbered by commercial obligations.
- **No spam-like automation.** Do not add features that encourage bulk messaging,
  mass automation, or anything that increases account-ban risk for users.
- **Protect credentials.** Never log, print, or transmit Zalo credentials
  (`imei` + `cookie` + `userAgent`). Never paste real credentials into issues,
  PRs, tests, or fixtures. The repo's `.gitignore` blocks `*.cred.json` and
  `cookies.json` — keep it that way.

## Sign the CLA (required)

Every contribution requires agreement to the
[Contributor License Agreement](./CLA.md). To sign:

1. Add yourself to [`CONTRIBUTORS.md`](./CONTRIBUTORS.md) in your first PR.
2. Sign off **every** commit with the Developer Certificate of Origin trailer:

   ```bash
   git commit -s -m "your message"
   ```

   This adds `Signed-off-by: Your Name <your.email@example.com>`. Pull requests
   whose commits are not signed off cannot be merged.

## Development setup

This is a **Tauri v2** app: a Rust core (`src-tauri/`) with a SvelteKit / Svelte 5
frontend (`src/`). The package manager is **bun**.

```bash
# Install frontend deps
bun install

# Run the app in dev mode (starts Vite + the Tauri shell)
bun run tauri dev
```

### Useful commands

| Task                 | Command                                                            |
| -------------------- | ----------------------------------------------------------------- |
| Frontend build       | `bun run build`                                                   |
| Frontend type-check  | `bun run check`                                                   |
| Rust build           | `cargo build --manifest-path src-tauri/Cargo.toml`               |
| Rust tests           | `cargo test --manifest-path src-tauri/Cargo.toml`                |
| Rust lint            | `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` |

## Architecture

The Rust core follows a strict **forward-only layer order**:

```
types → config → store → zalo → session → command
```

A module may only depend on layers earlier in that list. The SvelteKit frontend
is the `ui` layer and talks to `command/` via Tauri `invoke`/`listen`. See
[ADR-0003](./.harness/docs/adr/0003-rust-core-layering.md) and
[`.harness/docs/architecture.md`](./.harness/docs/architecture.md) for the
rationale.

- **Do not** add or rename a layer without an Architecture Decision Record
  (`.harness/docs/adr/`).
- **Do not** add dependencies with native bindings without an ADR.

This repository is developed with the
[agent-harness-kit](https://github.com/tuanle96/agent-harness-kit) workflow. You
do **not** need the harness to contribute a normal fix, but please keep changes
small and aligned with existing patterns.

## Pull request checklist

Before opening a PR, make sure:

- [ ] The frontend builds (`bun run build`) and type-checks (`bun run check`).
- [ ] Rust builds, tests pass, and clippy is clean (`-D warnings`).
- [ ] No credentials, secrets, or `*.cred.json` / `cookies.json` files are included.
- [ ] Commits are signed off (`git commit -s`) and you're listed in `CONTRIBUTORS.md`.
- [ ] The change respects the layer order and the noncommercial / no-spam posture.
- [ ] Commit messages are clear and describe the "why".

## Reporting bugs & requesting features

Use the GitHub issue tracker. For bugs, include your OS, app version, and clear
reproduction steps. **Never** include credentials or personal message content.

## Security issues

Please do **not** open public issues for security or credential-handling
vulnerabilities. Follow the process in [SECURITY.md](./SECURITY.md).
