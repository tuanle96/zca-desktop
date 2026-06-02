//! `command` layer — Tauri command handlers; the boundary the UI calls
//! (ADR-0003, top of the forward-only order).
//!
//! Commands validate external input at this boundary (golden principle #2) and
//! return only non-secret DTOs to the frontend. Credential token values
//! (imei/cookie/userAgent) are never serialized back across the IPC bridge.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::types::{AccountId, AccountProfile, Contact, CredentialSummary, Credentials, IncomingMessage, QrLoginEvent};
use crate::zalo::{self, Listener, API};

/// Tauri event name the frontend subscribes to for incoming chat messages.
pub const MESSAGE_EVENT: &str = "zalo://message";

/// Tauri event name the frontend subscribes to for QR-login progress.
pub const QR_EVENT: &str = "zalo://qr";

/// Holds authenticated sessions and their realtime listeners so both stay alive
/// for the app lifetime. Registered as Tauri managed state in `run()`.
///
/// This is the minimal single-process session store; the multi-account
/// `SessionManager` (session-manager feature) will generalize it.
#[derive(Default)]
pub struct ListenerState {
    /// Authenticated API handles keyed by account id.
    sessions: Mutex<HashMap<AccountId, Arc<API>>>,
    /// Live listener handles (kept so their sockets are not dropped).
    listeners: Mutex<Vec<Listener>>,
}

/// Managed handle to the local SQLite store (ADR-0005). `None` when the store
/// failed to open (logging still works; persistence becomes a no-op).
pub struct StoreState(pub Option<Arc<crate::store::Db>>);

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
    store: State<'_, StoreState>,
    payload: String,
) -> Result<AccountProfile, String> {
    let credentials: Credentials = serde_json::from_str(&payload)
        .map_err(|e| format!("invalid credential JSON: {e}"))?;
    credentials.validate().map_err(|e| e.to_string())?;
    login_and_listen(&app, &state, credentials, store.0.as_ref(), true).await
}

/// Run the interactive QR-code login flow and, on success, start the realtime
/// listener for the scanned account (ADR-0004).
///
/// QR progress is streamed to the UI as non-secret [`QrLoginEvent`]s on the
/// `zalo://qr` Tauri event. The credential triple (imei + cookie + user_agent)
/// the flow produces is assembled and used entirely inside the core — it is
/// never serialized back across the IPC boundary. Returns the logged-in
/// [`AccountProfile`] once the socket has started.
#[tauri::command]
pub async fn start_qr_login(
    app: AppHandle,
    state: State<'_, ListenerState>,
    store: State<'_, StoreState>,
) -> Result<AccountProfile, String> {
    tracing::info!("start_qr_login: beginning interactive QR login");
    // Bridge the sync QR callback to the UI: forward each non-secret stage
    // event over a channel into `zalo://qr`.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<QrLoginEvent>(16);
    let emitter = app.clone();
    let pump = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            tracing::debug!(stage = ?std::mem::discriminant(&event), "qr stage event");
            if emitter.emit(QR_EVENT, &event).is_err() {
                break; // app shutting down
            }
        }
    });

    let credentials = zalo::run_qr_login(tx).await.map_err(|e| {
        tracing::error!(error = %e, "start_qr_login: QR flow failed");
        format!("QR login failed: {e}")
    })?;

    // Drain any remaining display events before continuing.
    let _ = pump.await;

    tracing::info!("start_qr_login: QR confirmed, establishing session");
    let result = login_and_listen(&app, &state, credentials, store.0.as_ref(), true).await;
    match &result {
        Ok(profile) => tracing::info!(account_id = %profile.account_id, "start_qr_login: session established"),
        Err(e) => tracing::error!(error = %e, "start_qr_login: session login failed after QR"),
    }
    result
}

/// Shared login + listener-start path. Registers the session, spawns the event
/// bridge (which persists every observed message to `store`), and — when
/// `save_cred` is set — saves the account's encrypted credential for restore.
///
/// `credentials` is consumed by the network login; a clone is kept for
/// credential persistence only when `save_cred` is true. The credential never
/// crosses IPC.
async fn login_and_listen(
    app: &AppHandle,
    state: &ListenerState,
    credentials: Credentials,
    store: Option<&Arc<crate::store::Db>>,
    save_cred: bool,
) -> Result<AccountProfile, String> {
    // Keep a copy for encrypted credential persistence before login consumes it.
    let to_persist = if save_cred { Some(credentials.clone()) } else { None };

    let api = Arc::new(
        zalo::login(credentials)
            .await
            .map_err(|e| format!("login failed: {e}"))?,
    );
    let profile = zalo::profile_of(&api).await;
    state
        .sessions
        .lock()
        .await
        .insert(profile.account_id.clone(), api.clone());

    // Persist the account + encrypted credential (best-effort; a store failure
    // must not break an otherwise-successful login).
    if let (Some(db), Some(creds)) = (store, to_persist) {
        match db.save_account(&profile, &creds) {
            Ok(()) => tracing::info!(account_id = %profile.account_id, "persisted account credential"),
            Err(e) => tracing::warn!(account_id = %profile.account_id, error = %e, "failed to persist credential"),
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<IncomingMessage>(256);
    let listener = zalo::start_message_listener(api, tx)
        .await
        .map_err(|e| format!("listener failed to start: {e}"))?;
    state.listeners.lock().await.push(listener);

    // The bridge persists each observed message to the local store (ADR-0005)
    // before forwarding it to the UI, so history survives restarts.
    let app = app.clone();
    let db = store.cloned();
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Some(db) = db.as_ref() {
                persist_incoming(db, &msg);
            }
            if app.emit(MESSAGE_EVENT, &msg).is_err() {
                break; // app shutting down
            }
        }
    });

    Ok(profile)
}

/// Persist an incoming message into the local store (best-effort; a store
/// failure is logged and never breaks the realtime bridge).
fn persist_incoming(db: &Arc<crate::store::Db>, msg: &IncomingMessage) {
    let kind = match msg.thread_kind {
        crate::types::ThreadKind::Group => "group",
        crate::types::ThreadKind::User => "user",
    };
    // Realtime events carry no reliable epoch; stamp with receive time (millis).
    let ts = now_millis();
    let bump_unread = !msg.is_self;
    if let Err(e) = db.save_message(
        &msg.account_id,
        &msg.thread_id,
        kind,
        &msg.msg_id,
        Some(&msg.from_id),
        msg.from_name.as_deref(),
        msg.text.as_deref(),
        msg.is_self,
        Some(ts),
        msg.from_name.as_deref(),
        None,
        bump_unread,
    ) {
        tracing::warn!(error = %e, "failed to persist incoming message");
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Restore previously saved accounts on startup: load each from the store,
/// decrypt its credential, and re-login/listen. Returns the profiles that came
/// back online. An account whose login fails is marked `reauth-needed` and
/// skipped so the others still restore.
#[tauri::command]
pub async fn restore_sessions(
    app: AppHandle,
    state: State<'_, ListenerState>,
    store: State<'_, StoreState>,
) -> Result<Vec<AccountProfile>, String> {
    let Some(db) = store.0.clone() else {
        return Ok(Vec::new());
    };
    let saved = db.load_accounts().map_err(|e| format!("failed to load saved accounts: {e}"))?;
    tracing::info!(count = saved.len(), "restore_sessions: restoring saved accounts");

    let mut restored = Vec::new();
    for account in saved {
        let account_id = account.profile.account_id.clone();
        // Credential is unchanged: persist messages (Some(db)) but not the
        // credential again (save_cred = false).
        match login_and_listen(&app, &state, account.credentials, Some(&db), false).await {
            Ok(profile) => restored.push(profile),
            Err(e) => {
                tracing::warn!(account_id = %account_id, error = %e, "restore failed; marking reauth-needed");
                let _ = db.mark_reauth_needed(&account_id);
            }
        }
    }
    Ok(restored)
}

/// Resolve the dev credential file. The path is fixed (env `ZALO_CRED_FILE`, or
/// the gitignored `.zalo-cred.json` at the repo root) — the UI never supplies a
/// path, so this cannot be used to read arbitrary files. Dev affordance only;
/// the real flow is a file picker / OS keychain (secure-cred-store).
fn dev_cred_path() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("ZALO_CRED_FILE") {
        return std::path::PathBuf::from(p);
    }
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.zalo-cred.json")
}

/// Read + validate credentials from the dev session file. Never returns or logs
/// token values.
fn read_dev_credentials() -> Result<Credentials, String> {
    let path = dev_cred_path();
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        "no session file found — copy .zalo-cred.example.json to .zalo-cred.json at the repo root".to_string()
    })?;
    let credentials: Credentials =
        serde_json::from_str(&raw).map_err(|e| format!("invalid .zalo-cred.json: {e}"))?;
    credentials.validate().map_err(|e| e.to_string())?;
    Ok(credentials)
}

/// Non-secret summary of the dev session file so the UI can confirm it is
/// present and well-formed without ever loading the token values.
#[tauri::command]
pub fn cred_file_summary() -> Result<CredentialSummary, String> {
    let credentials = read_dev_credentials()?;
    Ok(CredentialSummary {
        imei_len: credentials.imei.len(),
        cookie_count: credentials.cookie.len(),
        user_agent_len: credentials.user_agent.len(),
        language: credentials.language.clone(),
    })
}

/// Log in using the dev session file and return the account profile. The
/// credential never enters the UI.
#[tauri::command]
pub async fn login_from_file() -> Result<AccountProfile, String> {
    let credentials = read_dev_credentials()?;
    zalo::login_profile(credentials)
        .await
        .map_err(|e| format!("login failed: {e}"))
}

/// Log in using the dev session file and start the realtime listener. The
/// credential is read by the core from disk and never enters the UI.
#[tauri::command]
pub async fn start_listening_from_file(
    app: AppHandle,
    state: State<'_, ListenerState>,
    store: State<'_, StoreState>,
) -> Result<AccountProfile, String> {
    let credentials = read_dev_credentials()?;
    login_and_listen(&app, &state, credentials, store.0.as_ref(), true).await
}

/// Send a plain-text message to a user thread from an already-authenticated
/// account, returning the new message id.
///
/// Requires a prior `login`/`start_listening` for `account_id` (the session is
/// reused from managed state — credentials are never re-sent from the UI).
/// `thread_id` and `text` are validated at this boundary.
#[tauri::command]
pub async fn send_message(
    state: State<'_, ListenerState>,
    store: State<'_, StoreState>,
    account_id: String,
    thread_id: String,
    text: String,
) -> Result<String, String> {
    if thread_id.trim().is_empty() {
        return Err("thread_id is required".to_string());
    }
    if text.trim().is_empty() {
        return Err("message text is required".to_string());
    }
    let api = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&account_id)
            .cloned()
            .ok_or_else(|| format!("no active session for account {account_id}; log in first"))?
    };
    let msg_id = zalo::send_text(&api, &thread_id, &text)
        .await
        .map_err(|e| format!("send failed: {e}"))?;

    // Persist the outgoing message so it survives restart (best-effort). Use a
    // local id when the API returned an empty one so the row is still stored.
    if let Some(db) = store.0.as_ref() {
        let stored_id = if msg_id.is_empty() {
            format!("local-{}", now_millis())
        } else {
            msg_id.clone()
        };
        if let Err(e) = db.save_message(
            &account_id,
            &thread_id,
            "user",
            &stored_id,
            Some(&account_id),
            None,
            Some(&text),
            true,
            Some(now_millis()),
            None,
            None,
            false,
        ) {
            tracing::warn!(error = %e, "failed to persist outgoing message");
        }
    }
    Ok(msg_id)
}

/// Load persisted conversation history (threads + recent messages) for an
/// account from the local store, so the UI can show prior chats at startup
/// without waiting for a realtime event.
#[tauri::command]
pub fn load_history(
    store: State<'_, StoreState>,
    account_id: String,
) -> Result<crate::types::History, String> {
    let Some(db) = store.0.as_ref() else {
        return Ok(crate::types::History { threads: Vec::new(), messages: Vec::new() });
    };
    let threads = db.load_threads(&account_id).map_err(|e| format!("load threads failed: {e}"))?;
    // Cap restore cost; the UI lazy-loads more per thread later if needed.
    let messages = db
        .load_recent_messages(&account_id, 2000)
        .map_err(|e| format!("load messages failed: {e}"))?;
    Ok(crate::types::History { threads, messages })
}

/// Clear a thread's unread counter in the store when the UI opens it.
#[tauri::command]
pub fn mark_thread_read(
    store: State<'_, StoreState>,
    account_id: String,
    thread_id: String,
) -> Result<(), String> {
    if let Some(db) = store.0.as_ref() {
        db.clear_unread(&account_id, &thread_id)
            .map_err(|e| format!("clear unread failed: {e}"))?;
    }
    Ok(())
}

/// List the friends/contacts of an authenticated account.
///
/// Reuses the stored session for `account_id` (log in first). Returns non-secret
/// [`Contact`] DTOs sorted by display name.
#[tauri::command]
pub async fn list_contacts(
    state: State<'_, ListenerState>,
    account_id: String,
) -> Result<Vec<Contact>, String> {
    let api = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&account_id)
            .cloned()
            .ok_or_else(|| format!("no active session for account {account_id}; log in first"))?
    };
    zalo::list_contacts(&api)
        .await
        .map_err(|e| format!("failed to load contacts: {e}"))
}

/// Forward a log line from the webview/UI into the unified tracing sink so
/// frontend diagnostics land in the same rolling log files as the core.
///
/// `level` is one of `error`/`warn`/`info`/`debug` (anything else → `info`).
/// The UI must not send secrets here; messages are recorded as-is.
#[tauri::command]
pub fn log_from_ui(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "ui", "{message}"),
        "warn" => tracing::warn!(target: "ui", "{message}"),
        "debug" => tracing::debug!(target: "ui", "{message}"),
        _ => tracing::info!(target: "ui", "{message}"),
    }
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

    /// The dev cred path is fixed and repo-local, and a missing/unreadable file
    /// yields a clear, value-free error. Combined into one test because both
    /// touch the shared ZALO_CRED_FILE env var (parallel tests would race).
    #[test]
    fn dev_cred_path_is_repo_local_and_missing_file_errors() {
        let saved = std::env::var("ZALO_CRED_FILE").ok();

        std::env::remove_var("ZALO_CRED_FILE");
        let path = dev_cred_path();
        assert!(
            path.to_string_lossy().ends_with(".zalo-cred.json"),
            "default dev cred path must be the repo-root .zalo-cred.json"
        );

        std::env::set_var("ZALO_CRED_FILE", "/nonexistent/zca-no-such-cred.json");
        // Credentials has no Debug derive, so match instead of expect_err.
        let result = read_dev_credentials();
        match result {
            Ok(_) => panic!("missing file must error"),
            Err(err) => assert!(err.contains("no session file found"), "got: {err}"),
        }

        match saved {
            Some(v) => std::env::set_var("ZALO_CRED_FILE", v),
            None => std::env::remove_var("ZALO_CRED_FILE"),
        }
    }

    /// Live: cred_file_summary reads the real .zalo-cred.json and reports only
    /// non-secret counts/lengths. Ignored by default.
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored cred_file_summary_live --nocapture
    #[test]
    #[ignore = "requires real .zalo-cred.json"]
    fn cred_file_summary_live() {
        let summary = cred_file_summary().expect("session file must load");
        assert!(summary.cookie_count > 0, "expected at least one cookie");
        assert!(summary.imei_len > 0 && summary.user_agent_len > 0);
        println!(
            "cred_file_summary_live OK: cookies={} imei_len={} ua_len={} lang={}",
            summary.cookie_count, summary.imei_len, summary.user_agent_len, summary.language
        );
    }

    /// Live: login_from_file logs in using the on-disk session and returns a
    /// non-empty account id. Ignored by default.
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored login_from_file_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; performs a live login"]
    async fn login_from_file_live() {
        let profile = login_from_file().await.expect("file-backed login failed");
        assert!(!profile.account_id.is_empty(), "account_id must be non-empty");
        println!(
            "login_from_file_live OK: uid_len={} has_display_name={}",
            profile.account_id.len(),
            profile.display_name.is_some()
        );
    }
}
