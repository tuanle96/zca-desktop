//! `config` layer — app configuration, paths, env loading, and logging
//! (ADR-0003: `types → config → store → zalo → session → command`).
//!
//! This is the only layer that reads process environment variables; higher
//! layers receive typed values. It also owns the logging/observability setup so
//! every layer can emit structured traces and raw API captures for debugging.
//!
//! Security: Zalo credentials (imei + cookie + userAgent) and login-response
//! secrets (zpw_enk / secret_key / tokens) are bearer tokens. Raw capture
//! REDACTS these by default; full unredacted raw is opt-in via `ZCA_LOG_RAW=1`
//! for local debugging only, and never on by default.

pub mod logging;
pub mod redact;

use std::path::PathBuf;

/// App-wide configuration resolved once at startup from the environment.
#[derive(Debug, Clone)]
pub struct Config {
    /// Directory where rolling log files + raw API captures are written.
    pub log_dir: PathBuf,
    /// Log verbosity filter (e.g. `info`, `debug`, `zca_desktop_lib=trace`).
    pub log_filter: String,
    /// When true, raw API captures are written WITHOUT redaction. Opt-in only
    /// (`ZCA_LOG_RAW=1`); intended for local root-cause debugging.
    pub log_raw_unredacted: bool,
}

impl Config {
    /// Resolve configuration from environment variables, with safe defaults.
    ///
    /// - `ZCA_LOG_DIR` — log directory (default: `<app-data>/logs`, falling back
    ///   to `./logs` if no app-data dir is supplied).
    /// - `ZCA_LOG` / `RUST_LOG` — log filter (default: `info`).
    /// - `ZCA_LOG_RAW` — `1`/`true` to disable redaction of raw captures.
    pub fn from_env(default_log_dir: PathBuf) -> Self {
        let log_dir = std::env::var("ZCA_LOG_DIR")
            .map(PathBuf::from)
            .unwrap_or(default_log_dir);

        let log_filter = std::env::var("ZCA_LOG")
            .or_else(|_| std::env::var("RUST_LOG"))
            .unwrap_or_else(|_| "info".to_string());

        let log_raw_unredacted = matches!(
            std::env::var("ZCA_LOG_RAW").ok().as_deref(),
            Some("1") | Some("true") | Some("TRUE")
        );

        Config {
            log_dir,
            log_filter,
            log_raw_unredacted,
        }
    }
}
