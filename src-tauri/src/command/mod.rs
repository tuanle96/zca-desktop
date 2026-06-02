//! `command` layer — Tauri command handlers; the boundary the UI calls
//! (ADR-0003, top of the forward-only order).
//!
//! Commands validate external input at this boundary (golden principle #2) and
//! return only non-secret DTOs to the frontend. Credential token values
//! (imei/cookie/userAgent) are never serialized back across the IPC bridge.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::types::{AccountProfile, CredentialSummary, Credentials, IncomingMessage};
use crate::zalo::{self, Listener};

/// Tauri event name the frontend subscribes to for incoming chat messages.
pub const MESSAGE_EVENT: &str = "zalo://message";

/// Holds the running realtime listener(s) so their sockets stay alive for the
/// app lifetime. Registered as Tauri managed state in `run()`.
#[derive(Default)]
pub struct ListenerState {
    listeners: Mutex<Vec<Listener>>,
}

/// Import a `ZaloDataExtractor` JSON export.
///
/// Parses the raw JSON, validates required fields, and returns a non-secret
/// [`CredentialSummary`]. The credential token values stay in the core and are
/// never returned to the UI. Errors are plain messages with no token values.
///
/// Note: this command does not persist anything yet — secure storage lands in
/// the Phase 3 keychain feature.
#[tauri::command]
pub fn import_credentials(payload: String) -> Result<CredentialSummary, String> {
    let credentials: Credentials = serde_json::from_str(&payload)
        .map_err(|e| format!("invalid credential JSON: {e}"))?;
    credentials.validate().map_err(|e| e.to_string())?;
    Ok(CredentialSummary {
        imei_len: credentials.imei.len(),
        cookie_count: credentials.cookie.len(),
        user_agent_len: credentials.user_agent.len(),
        language: credentials.language.clone(),
    })
}

/// Log in one account from a `ZaloDataExtractor` JSON export and return its
/// public profile (account id + best-effort display name).
///
/// Parses + validates the payload at this boundary, then delegates the network
/// login to the `zalo` layer. Only the non-secret [`AccountProfile`] crosses
/// back to the UI; credential token values never leave the core. Nothing is
/// persisted yet (Phase 3 keychain).
#[tauri::command]
pub async fn login(payload: String) -> Result<AccountProfile, String> {
    let credentials: Credentials = serde_json::from_str(&payload)
        .map_err(|e| format!("invalid credential JSON: {e}"))?;
    credentials.validate().map_err(|e| e.to_string())?;
    crate::zalo::login_profile(credentials)
        .await
        .map_err(|e| format!("login failed: {e}"))
}

/// Log in and start forwarding incoming chat messages to the frontend as
/// `zalo://message` Tauri events. Returns the account profile once the realtime
/// socket has started.
///
/// The credential payload is validated at the boundary; only non-secret
/// [`IncomingMessage`] DTOs are emitted to the UI. The listener handle is kept
/// in managed state so the socket stays open for the app lifetime.
#[tauri::command]
pub async fn start_listening(
    app: AppHandle,
    state: State<'_, ListenerState>,
    payload: String,
) -> Result<AccountProfile, String> {
    let credentials: Credentials = serde_json::from_str(&payload)
        .map_err(|e| format!("invalid credential JSON: {e}"))?;
    credentials.validate().map_err(|e| e.to_string())?;

    let api = Arc::new(
        zalo::login(credentials)
            .await
            .map_err(|e| format!("login failed: {e}"))?,
    );
    let profile = zalo::profile_of(&api).await;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<IncomingMessage>(256);
    let listener = zalo::start_message_listener(api, tx)
        .await
        .map_err(|e| format!("listener failed to start: {e}"))?;
    state.listeners.lock().await.push(listener);

    // Forward each bridged message to the frontend.
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if app.emit(MESSAGE_EVENT, &msg).is_err() {
                break; // app shutting down
            }
        }
    });

    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_payload() -> String {
        // Synthetic, non-real values — exercises parsing/validation only.
        serde_json::json!({
            "imei": "test-imei-0000",
            "cookie": [{ "domain": ".zalo.me", "name": "zpsid", "value": "x" }],
            "userAgent": "Mozilla/5.0 (Test)",
            "language": "vi"
        })
        .to_string()
    }

    #[test]
    fn import_accepts_valid_payload() {
        let summary = import_credentials(valid_payload()).expect("valid payload must import");
        assert_eq!(summary.cookie_count, 1);
        assert_eq!(summary.language, "vi");
        assert!(summary.imei_len > 0 && summary.user_agent_len > 0);
    }

    #[test]
    fn import_rejects_malformed_json() {
        let err = import_credentials("{ not json ".to_string()).expect_err("malformed JSON must fail");
        assert!(err.contains("invalid credential JSON"), "got: {err}");
    }

    #[test]
    fn import_rejects_empty_cookies() {
        let payload = serde_json::json!({
            "imei": "test-imei-0000",
            "cookie": [],
            "userAgent": "Mozilla/5.0 (Test)"
        })
        .to_string();
        let err = import_credentials(payload).expect_err("empty cookies must fail");
        assert!(err.contains("at least one cookie"), "got: {err}");
    }

    #[test]
    fn import_rejects_missing_imei() {
        let payload = serde_json::json!({
            "imei": "   ",
            "cookie": [{ "domain": ".zalo.me", "name": "zpsid", "value": "x" }],
            "userAgent": "Mozilla/5.0 (Test)"
        })
        .to_string();
        let err = import_credentials(payload).expect_err("blank imei must fail");
        assert!(err.contains("imei"), "got: {err}");
    }

    /// Defaulting: language is optional in the export and defaults to "vi".
    #[test]
    fn import_defaults_language() {
        let payload = serde_json::json!({
            "imei": "test-imei-0000",
            "cookie": [{ "domain": ".zalo.me", "name": "zpsid", "value": "x" }],
            "userAgent": "Mozilla/5.0 (Test)"
        })
        .to_string();
        let summary = import_credentials(payload).expect("must import");
        assert_eq!(summary.language, "vi");
    }
}
