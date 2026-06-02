# Logging & raw API capture

The Rust core uses `tracing` for structured logs and writes rolling daily files
so any API/Tauri/QR issue can be traced and root-caused after the fact. The
webview forwards its own log lines into the same sink via the `log_from_ui`
command, so frontend and core diagnostics interleave in one place.

## Where logs go

- Default dir: `<OS app-data>/zca-desktop/logs/`
  - macOS: `~/Library/Application Support/zca-desktop/logs/`
  - Windows: `%APPDATA%/zca-desktop/logs/`
  - Linux: `$XDG_DATA_HOME/zca-desktop/logs/` (or `~/.local/share/...`)
  - Fallback (no home): `./logs/` relative to the working dir.
- `zca-desktop.log.<YYYY-MM-DD>` — structured event log (console mirror on `tauri dev`).
- `raw-<YYYY-MM-DD>.log` — raw API request/response captures for debugging.

Both `logs/` and `*.log` are gitignored.

## Security: redaction is the default

Zalo credentials (imei + cookie + userAgent) and login-response secrets
(`zpw_enk`, `secret_key`, tokens, `zpsid`, `zpw_sek`, …) are bearer tokens.

- Raw captures are **redacted by default**: secret-keyed JSON values and
  `key=value` secret pairs are replaced with `***redacted(<len>)***`, preserving
  only length, never content. See `src-tauri/src/config/redact.rs`.
- The structured event log never logs credential values; the credential
  `Credentials` type has no `Debug` derive by design.

## Environment variables

| Var | Default | Effect |
| --- | --- | --- |
| `ZCA_LOG` / `RUST_LOG` | `info` | Tracing filter, e.g. `debug`, `zca_desktop_lib=trace,zca_rust=debug`. |
| `ZCA_LOG_DIR` | OS app-data `…/logs` | Override the log directory. |
| `ZCA_LOG_RAW` | unset | When `1`/`true`, raw captures are written **UNREDACTED**. Local deep-debug only — logs a startup warning. Never enable when sharing logs. |

## Adding a capture point

From any layer:

```rust
crate::config::logging::capture_raw("qr.login_response", &raw_body);
```

`capture_raw` redacts (unless `ZCA_LOG_RAW=1`), writes one grep-friendly line
per entry, and never panics — diagnostics must not break the main flow.
