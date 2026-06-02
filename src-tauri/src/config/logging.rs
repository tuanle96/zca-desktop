//! Logging + raw API capture setup (`config` layer).
//!
//! Provides:
//!   - [`init`]: structured `tracing` to stderr (dev console) AND a rolling
//!     daily log file under the configured log dir.
//!   - [`capture_raw`]: append a raw API request/response payload to a daily
//!     `raw-*.log` capture file for root-cause debugging. Payloads are REDACTED
//!     by default (see [`super::redact`]); full raw requires `ZCA_LOG_RAW=1`.
//!
//! The file writer guard returned by [`init`] must be kept alive for the app
//! lifetime (dropping it stops the background flush thread).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use super::{redact, Config};

/// Resolved runtime logging settings, set once by [`init`] so [`capture_raw`]
/// (called from any layer) knows where to write and whether to redact.
struct RawSink {
    dir: PathBuf,
    redact: bool,
}

static RAW_SINK: OnceLock<RawSink> = OnceLock::new();

/// Initialize tracing (console + rolling daily file) from `config`.
///
/// Returns the file-appender guard; keep it alive for the process lifetime.
/// Safe to call once at startup. If the log dir cannot be created, logging
/// still initializes to the console and raw capture becomes a no-op.
#[must_use = "drop of the returned guard stops file logging"]
pub fn init(config: &Config) -> Option<WorkerGuard> {
    let filter = EnvFilter::try_new(&config.log_filter)
        .unwrap_or_else(|_| EnvFilter::new("info"));

    // Console layer (stderr) — always on, for `tauri dev`.
    let console_layer = fmt::layer().with_target(true).with_writer(std::io::stderr);

    let guard = match fs::create_dir_all(&config.log_dir) {
        Ok(()) => {
            let file_appender =
                tracing_appender::rolling::daily(&config.log_dir, "zca-desktop.log");
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
            let file_layer = fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(non_blocking);

            tracing_subscriber::registry()
                .with(filter)
                .with(console_layer)
                .with(file_layer)
                .init();
            Some(guard)
        }
        Err(e) => {
            // Fall back to console-only logging; do not panic on a log-dir issue.
            tracing_subscriber::registry()
                .with(filter)
                .with(console_layer)
                .init();
            eprintln!("zca-desktop: could not create log dir {:?}: {e}", config.log_dir);
            None
        }
    };

    let _ = RAW_SINK.set(RawSink {
        dir: config.log_dir.clone(),
        redact: !config.log_raw_unredacted,
    });

    if config.log_raw_unredacted {
        tracing::warn!(
            "ZCA_LOG_RAW is enabled — raw API captures are UNREDACTED and may contain bearer tokens. Use for local debugging only."
        );
    }
    tracing::info!(log_dir = %config.log_dir.display(), filter = %config.log_filter, "logging initialized");

    guard
}

/// Append a raw API payload to today's raw-capture file for debugging.
///
/// `label` identifies the call site (e.g. `"qr.login_response"`). `payload` is
/// the raw body/string. By default the payload is run through
/// [`redact::redact_str`] so bearer tokens never hit disk; `ZCA_LOG_RAW=1`
/// disables that. A capture failure is logged and swallowed — diagnostics must
/// never break the main flow.
pub fn capture_raw(label: &str, payload: &str) {
    let Some(sink) = RAW_SINK.get() else {
        // Logging not initialized (e.g. unit tests) — emit at trace and return.
        tracing::trace!(label, "raw capture skipped (sink uninitialized)");
        return;
    };

    let body = if sink.redact {
        redact::redact_str(payload)
    } else {
        payload.to_string()
    };

    if let Err(e) = append_raw(&sink.dir, label, &body) {
        tracing::warn!(label, error = %e, "failed to write raw capture");
    }
}

fn append_raw(dir: &Path, label: &str, body: &str) -> std::io::Result<()> {
    // One file per day; entries are single-line JSON-ish for easy grepping.
    let date = current_date();
    let path = dir.join(format!("raw-{date}.log"));
    let ts = current_timestamp();
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    // Keep the body on one logical line so each capture is a single grep hit.
    let one_line = body.replace('\n', "\\n");
    writeln!(file, "{ts} [{label}] {one_line}")
}

/// Best-effort UTC-ish date stamp (YYYY-MM-DD) without pulling in a date crate.
fn current_date() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn current_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let secs_of_day = now % 86_400;
    let (h, mi, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    let days = now / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Convert days-since-epoch to a civil (year, month, day). Howard Hinnant's
/// algorithm — avoids a chrono dependency for a stamp we only use in filenames.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `append_raw` writes a grep-friendly single line and redaction (applied by
    /// the caller in `capture_raw`) keeps secrets out of the file. Here we drive
    /// `append_raw` with an already-redacted body and assert the file shape.
    #[test]
    fn append_raw_writes_single_grep_line() {
        let dir = std::env::temp_dir().join(format!("zca-log-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);

        let redacted = redact::redact_str(r#"{"zpw_enk":"leak","uid":"42"}"#);
        append_raw(&dir, "test.capture", &redacted).expect("append must succeed");

        // Find today's raw file and assert content.
        let date = current_date();
        let path = dir.join(format!("raw-{date}.log"));
        let contents = fs::read_to_string(&path).expect("raw file must exist");
        assert!(contents.contains("[test.capture]"), "label missing: {contents}");
        assert!(!contents.contains("leak"), "secret leaked into raw file: {contents}");
        assert!(contents.contains("42"), "non-secret must survive: {contents}");
        assert_eq!(contents.lines().count(), 1, "one capture = one line");

        let _ = fs::remove_dir_all(&dir);
    }
}
