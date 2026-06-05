# Zalo Mobile (Tauri Mobile, thin client)

A thin cloud client for iOS/Android. It reuses the shared frontend packages
(`@zca/types`, `@zca/core-client`) and Rust crates (`zca-cloud-client`,
`zca-keychain`) and speaks the **same `cloud_*` IPC contract** as the desktop, so
no client logic is duplicated. The Zalo session is hosted server-side; the device
token lives in the OS keychain (referenced over IPC by the `__keychain__`
sentinel) and never enters the webview.

## Develop / build (frontend)

```bash
bun install                      # from the repo root (links the workspace)
cd apps/mobile
bun run check                    # svelte-check
bun run build                    # → apps/mobile/build (embedded by the Rust core)
```

## Build the app (needs platform SDKs — run locally)

```bash
cd apps/mobile
bun run tauri ios init           # once; needs Xcode
bun run tauri ios build          # or: bun run tauri ios dev

bun run tauri android init       # once; needs Android Studio / NDK
bun run tauri android build      # or: bun run tauri android dev
```

`cargo build -p zca-mobile` (from the repo root) compiles the Rust core for the
host as a quick sanity check without the mobile SDKs.

## Deep-link magic link

The verify flow opens a deep link back into the app. Configure in
`src-tauri/tauri.conf.json` under `plugins.deep-link`:

- **Desktop:** the `zca://` custom scheme (already set).
- **iOS (Universal Links):** host the association file at
  `https://<host>/.well-known/apple-app-site-association`:
  ```json
  { "applinks": { "details": [{ "appID": "<TEAMID>.app.zca.mobile", "paths": ["/verify*"] }] } }
  ```
- **Android (App Links):** host `https://<host>/.well-known/assetlinks.json`:
  ```json
  [{ "relation": ["delegate_permission/common.handle_all_urls"],
     "target": { "namespace": "android_app", "package_name": "app.zca.mobile",
                 "sha256_cert_fingerprints": ["<APK_SIGNING_CERT_SHA256>"] } }]
  ```

`<host>` must match `plugins.deep-link.mobile[].host` in `tauri.conf.json`.

## Keychain

- macOS / iOS / Windows / Linux: native keychain via the `keyring` crate.
- Android: `keyring` has no backend, so `zca-keychain` uses an app-private file
  store. The core sets `$ZCA_KEYCHAIN_DIR` to the app data dir at startup.
  Hardware-Keystore backing is a future hardening step.
