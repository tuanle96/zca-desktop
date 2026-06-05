//! Mobile core (Tauri Mobile) — a THIN client to the zca cloud server.
//!
//! Reuses the desktop's `cloud_*` IPC contract verbatim so the shared
//! `@zca/core-client` frontend package works unchanged on both platforms. HTTP
//! goes through the shared `zca-cloud-client` engine; the bearer device token
//! lives ONLY in the OS keychain (`zca-keychain`) and is referenced over IPC by
//! the `__keychain__` sentinel — the webview never sees the plaintext.

use futures_util::StreamExt;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use zca_cloud_client::{drain_sse_events, CloudClient};

/// Realtime event channel — MUST match `@zca/core-client`'s `CLOUD_EVENT`.
const CLOUD_EVENT: &str = "zca-cloud://event";
/// Keychain coordinates + the sentinel the webview passes in place of the token.
const KEYCHAIN_SERVICE: &str = "app.zca.mobile.device-token";
const KEYCHAIN_SENTINEL: &str = "__keychain__";

fn token_account(base_url: &str) -> String {
    format!("device-token::{base_url}")
}

fn save_token(base_url: &str, token: &str) -> Result<(), String> {
    zca_keychain::store(KEYCHAIN_SERVICE, &token_account(base_url), token).map_err(|e| e.to_string())
}

fn load_token(base_url: &str) -> Result<Option<String>, String> {
    zca_keychain::load(KEYCHAIN_SERVICE, &token_account(base_url)).map_err(|e| e.to_string())
}

/// Resolve a device-token argument: the `__keychain__` sentinel (or empty) loads
/// the real token from the keychain; any other value is used verbatim.
fn resolve_token(base_url: &str, device_token: &str) -> Result<String, String> {
    let token = device_token.trim();
    if !token.is_empty() && token != KEYCHAIN_SENTINEL {
        return Ok(token.to_string());
    }
    load_token(base_url)?.ok_or_else(|| "thiết bị chưa liên kết".to_string())
}

fn authed_client(base_url: &str, device_token: &str) -> Result<CloudClient, String> {
    let token = resolve_token(base_url, device_token)?;
    CloudClient::with_token(base_url, &token).map_err(|e| e.to_string())
}

/// After a link flow, persist the returned token in the keychain and replace it
/// with the sentinel so it never reaches the webview.
fn stash_token_and_redact(base_url: &str, mut resp: Value) -> Result<Value, String> {
    if let Some(token) = resp.get("deviceToken").and_then(Value::as_str) {
        save_token(base_url, token)?;
    }
    if let Some(obj) = resp.as_object_mut() {
        if obj.contains_key("deviceToken") {
            obj.insert("deviceToken".into(), Value::String(KEYCHAIN_SENTINEL.into()));
        }
    }
    Ok(resp)
}

#[tauri::command]
async fn cloud_load_device_session(base_url: String) -> Result<Option<Value>, String> {
    let has_token = load_token(&base_url)?.is_some();
    Ok(Some(serde_json::json!({
        "baseUrl": base_url.trim().trim_end_matches('/'),
        "hasDeviceToken": has_token,
    })))
}

#[tauri::command]
async fn cloud_clear_device_session(base_url: String) -> Result<(), String> {
    zca_keychain::delete(KEYCHAIN_SERVICE, &token_account(&base_url)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_request_magic_link(base_url: String, email: String) -> Result<Value, String> {
    CloudClient::new(&base_url)
        .map_err(|e| e.to_string())?
        .request_magic_link(&email)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_verify_magic_link(
    base_url: String,
    email: String,
    token: String,
    device_name: String,
    recovery_key: Option<String>,
) -> Result<Value, String> {
    let resp = CloudClient::new(&base_url)
        .map_err(|e| e.to_string())?
        .verify_magic_link(&email, &token, &device_name, recovery_key.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    stash_token_and_redact(&base_url, resp)
}

#[tauri::command]
async fn cloud_register_device(
    base_url: String,
    device_token: String,
    name: String,
    recovery_key: String,
) -> Result<Value, String> {
    let resp = authed_client(&base_url, &device_token)?
        .post(
            "/api/v1/devices",
            &serde_json::json!({ "name": name, "recoveryKey": recovery_key }),
        )
        .await
        .map_err(|e| e.to_string())?;
    stash_token_and_redact(&base_url, resp)
}

#[tauri::command]
async fn cloud_list_devices(base_url: String, device_token: String) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .get("/api/v1/devices")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_revoke_device(
    base_url: String,
    device_token: String,
    device_id: String,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .delete(&format!("/api/v1/devices/{device_id}"))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_list_accounts(base_url: String, device_token: String) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .get("/api/v1/accounts")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_start_account_qr(base_url: String, device_token: String) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post_empty("/api/v1/accounts/qr/start")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_get_qr_status(
    base_url: String,
    device_token: String,
    flow_id: String,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .get(&format!("/api/v1/accounts/qr/{flow_id}"))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_delete_account(
    base_url: String,
    device_token: String,
    account_id: String,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .delete(&format!("/api/v1/accounts/{account_id}"))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_list_contacts(
    base_url: String,
    device_token: String,
    account_id: String,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .get(&format!("/api/v1/accounts/{account_id}/contacts"))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_list_conversations(
    base_url: String,
    device_token: String,
    account_id: Option<String>,
) -> Result<Value, String> {
    let path = account_id
        .map(|id| format!("/api/v1/conversations?accountId={id}"))
        .unwrap_or_else(|| "/api/v1/conversations".to_string());
    authed_client(&base_url, &device_token)?
        .get(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_list_messages(
    base_url: String,
    device_token: String,
    conversation_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let path = format!(
        "/api/v1/conversations/{conversation_id}/messages?limit={}",
        limit.unwrap_or(100)
    );
    authed_client(&base_url, &device_token)?
        .get(&path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_send_text(
    base_url: String,
    device_token: String,
    account_id: String,
    thread_id: String,
    text: String,
    thread_kind: Option<String>,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(
            &format!("/api/v1/accounts/{account_id}/send/text"),
            &serde_json::json!({ "threadId": thread_id, "text": text, "threadKind": thread_kind }),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_send_sticker(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(&format!("/api/v1/accounts/{account_id}/send/sticker"), &payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_send_reaction(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(&format!("/api/v1/accounts/{account_id}/send/reaction"), &payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_send_file(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(&format!("/api/v1/accounts/{account_id}/send/file"), &payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_init_file(
    base_url: String,
    device_token: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post("/api/v1/files/init", &payload)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_upload_file_blob(
    base_url: String,
    device_token: String,
    file_id: String,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post_bytes(&format!("/api/v1/files/{file_id}/blob"), bytes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_download_file_blob(
    base_url: String,
    device_token: String,
    file_id: String,
) -> Result<Vec<u8>, String> {
    authed_client(&base_url, &device_token)?
        .get_bytes(&format!("/api/v1/files/{file_id}/blob"))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cloud_start_realtime(
    app: AppHandle,
    base_url: String,
    device_token: String,
) -> Result<(), String> {
    let client = authed_client(&base_url, &device_token)?;
    tauri::async_runtime::spawn(async move {
        let res = match client.open_sse("/api/v1/realtime").await {
            Ok(res) => res,
            Err(e) => {
                let _ = app.emit(
                    CLOUD_EVENT,
                    serde_json::json!({ "type": "error", "message": e.to_string() }),
                );
                let _ = app.emit(
                    CLOUD_EVENT,
                    serde_json::json!({ "type": "disconnected", "reason": "connect-error" }),
                );
                return;
            }
        };
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let _ = app.emit(
                CLOUD_EVENT,
                serde_json::json!({ "type": "disconnected", "reason": "status", "status": status }),
            );
            return;
        }
        let _ = app.emit(CLOUD_EVENT, serde_json::json!({ "type": "connected" }));
        let mut stream = res.bytes_stream();
        let mut buffer = String::new();
        let mut reason = "stream-ended";
        while let Some(item) = stream.next().await {
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(_) => {
                    reason = "stream-error";
                    break;
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            for json in drain_sse_events(&mut buffer) {
                let _ = app.emit(CLOUD_EVENT, json);
            }
        }
        let _ = app.emit(
            CLOUD_EVENT,
            serde_json::json!({ "type": "disconnected", "reason": reason }),
        );
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Deep linking carries the magic-link verify code into the app:
        // desktop/Linux/Windows register the `zca://` scheme; iOS uses Universal
        // Links and Android uses App Links (configured in tauri.conf.json).
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            // On Android, `keyring` has no backend; `zca-keychain` falls back to a
            // file store under $ZCA_KEYCHAIN_DIR. Point it at the app-private data
            // dir so the device token persists and isn't world-readable.
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                if let Ok(dir) = _app.path().app_data_dir() {
                    std::env::set_var("ZCA_KEYCHAIN_DIR", dir.join("keychain"));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cloud_load_device_session,
            cloud_clear_device_session,
            cloud_request_magic_link,
            cloud_verify_magic_link,
            cloud_register_device,
            cloud_list_devices,
            cloud_revoke_device,
            cloud_list_accounts,
            cloud_start_account_qr,
            cloud_get_qr_status,
            cloud_delete_account,
            cloud_list_contacts,
            cloud_list_conversations,
            cloud_list_messages,
            cloud_send_text,
            cloud_send_sticker,
            cloud_send_reaction,
            cloud_send_file,
            cloud_init_file,
            cloud_upload_file_blob,
            cloud_download_file_blob,
            cloud_start_realtime,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
