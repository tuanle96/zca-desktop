//! Cloud SaaS client boundary for the desktop app.
//!
//! Cloud SaaS is the desktop app's active session path. These commands let the
//! Svelte UI talk to the hosted session backend (ADR-0006) without moving Zalo
//! credentials into the webview. Cloud device tokens are SaaS bearer tokens;
//! callers must store them carefully, but they are not Zalo credential triples.
//!
//! The HTTP/SSE lives in the shared `zca-cloud-client` crate (the single Rust
//! home for the `/api/v1` contract, also used by the mobile core). These commands
//! are thin wrappers that (1) resolve the device token from the OS keychain,
//! (2) call the client, and (3) hand the webview the raw JSON `Value` — the
//! response *shapes* are typed on the TS side from the generated single-source
//! contract (`@zca/types`), so no DTO is redeclared here. The device token is
//! kept in the keychain and referenced by the `__keychain__` sentinel; it never
//! crosses IPC.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use zca_cloud_client::{drain_sse_events, CloudClient};

pub const CLOUD_EVENT: &str = "zca-cloud://event";
pub const CLOUD_DEVICE_TOKEN_KEYCHAIN: &str = "__keychain__";
const CLOUD_KEYRING_SERVICE: &str = "com.zca-desktop.cloud-device-session";

/// On-disk shape of the keychain entry (the token wrapped in JSON).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCloudDeviceSession {
    device_token: String,
}

// ---- keychain (desktop-only; the token never crosses IPC) ----

fn normalized_base_url(base_url: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("cloud base_url must start with http:// or https://".to_string());
    }
    Ok(base.to_string())
}

fn cloud_keyring_entry(base_url: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CLOUD_KEYRING_SERVICE, base_url)
        .map_err(|_| "cloud keychain access failed".to_string())
}

fn save_cloud_device_token(base_url: &str, device_token: &str) -> Result<(), String> {
    let base = normalized_base_url(base_url)?;
    let session = StoredCloudDeviceSession {
        device_token: device_token.to_string(),
    };
    let bytes = serde_json::to_vec(&session)
        .map_err(|_| "cloud session serialization failed".to_string())?;
    cloud_keyring_entry(&base)?
        .set_secret(&bytes)
        .map_err(|_| "cloud keychain access failed".to_string())
}

fn load_cloud_device_token(base_url: &str) -> Result<Option<String>, String> {
    let base = normalized_base_url(base_url)?;
    match cloud_keyring_entry(&base)?.get_secret() {
        Ok(bytes) => {
            let session: StoredCloudDeviceSession = serde_json::from_slice(&bytes)
                .map_err(|_| "cloud session keychain entry is malformed".to_string())?;
            Ok(Some(session.device_token))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("cloud keychain access failed".to_string()),
    }
}

fn resolve_device_token(base_url: &str, device_token: &str) -> Result<String, String> {
    let token = device_token.trim();
    if !token.is_empty() && token != CLOUD_DEVICE_TOKEN_KEYCHAIN {
        return Ok(token.to_string());
    }
    load_cloud_device_token(base_url)?.ok_or_else(|| "cloud device session not found".to_string())
}

// ---- client helpers ----

/// Build an authenticated client, resolving the device token from the keychain
/// when the `__keychain__` sentinel (or empty) is passed.
fn authed_client(base_url: &str, device_token: &str) -> Result<CloudClient, String> {
    let token = resolve_device_token(base_url, device_token)?;
    CloudClient::with_token(base_url, &token).map_err(|e| e.to_string())
}

/// After a link flow, persist the returned device token in the keychain and
/// replace it with the sentinel so the plaintext never reaches the webview.
fn stash_token_and_redact(base_url: &str, mut resp: Value) -> Result<Value, String> {
    if let Some(token) = resp.get("deviceToken").and_then(Value::as_str) {
        save_cloud_device_token(base_url, token)?;
    }
    if let Some(obj) = resp.as_object_mut() {
        if obj.contains_key("deviceToken") {
            obj.insert(
                "deviceToken".into(),
                Value::String(CLOUD_DEVICE_TOKEN_KEYCHAIN.into()),
            );
        }
    }
    Ok(resp)
}

// ---- commands ----

#[tauri::command]
pub async fn cloud_load_device_session(base_url: String) -> Result<Option<Value>, String> {
    let base = normalized_base_url(&base_url)?;
    Ok(load_cloud_device_token(&base)?
        .map(|_| serde_json::json!({ "baseUrl": base, "hasDeviceToken": true })))
}

#[tauri::command]
pub async fn cloud_clear_device_session(base_url: String) -> Result<(), String> {
    let base = normalized_base_url(&base_url)?;
    match cloud_keyring_entry(&base)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("cloud keychain access failed".to_string()),
    }
}

#[tauri::command]
pub async fn cloud_start_realtime(
    app: AppHandle,
    base_url: String,
    device_token: String,
) -> Result<(), String> {
    let client = authed_client(&base_url, &device_token)?;
    tokio::spawn(async move {
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
                serde_json::json!({ "type": "error", "status": status }),
            );
            let _ = app.emit(
                CLOUD_EVENT,
                serde_json::json!({ "type": "disconnected", "reason": "status", "status": status }),
            );
            return;
        }

        let _ = app.emit(CLOUD_EVENT, serde_json::json!({ "type": "connected" }));
        let mut stream = res.bytes_stream();
        let mut buffer = String::new();
        let mut disconnect_reason = "stream-ended";
        while let Some(item) = stream.next().await {
            let bytes = match item {
                Ok(bytes) => bytes,
                Err(e) => {
                    disconnect_reason = "stream-error";
                    let _ = app.emit(
                        CLOUD_EVENT,
                        serde_json::json!({ "type": "error", "message": e.to_string() }),
                    );
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
            serde_json::json!({ "type": "disconnected", "reason": disconnect_reason }),
        );
    });
    Ok(())
}

#[tauri::command]
pub async fn cloud_request_magic_link(base_url: String, email: String) -> Result<Value, String> {
    CloudClient::new(&base_url)
        .map_err(|e| e.to_string())?
        .request_magic_link(&email)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_oauth_providers(base_url: String) -> Result<Value, String> {
    CloudClient::new(&base_url)
        .map_err(|e| e.to_string())?
        .oauth_providers()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_verify_magic_link(
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
pub async fn cloud_verify_oauth_code(base_url: String, code: String) -> Result<Value, String> {
    let resp = CloudClient::new(&base_url)
        .map_err(|e| e.to_string())?
        .verify_oauth_desktop_code(&code)
        .await
        .map_err(|e| e.to_string())?;
    stash_token_and_redact(&base_url, resp)
}

#[tauri::command]
pub async fn cloud_register_device(
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
pub async fn cloud_list_devices(base_url: String, device_token: String) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .get("/api/v1/devices")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_revoke_device(
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
pub async fn cloud_list_accounts(base_url: String, device_token: String) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .get("/api/v1/accounts")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_start_account_qr(
    base_url: String,
    device_token: String,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post_empty("/api/v1/accounts/qr/start")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_get_qr_status(
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
pub async fn cloud_delete_account(
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
pub async fn cloud_list_contacts(
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
pub async fn cloud_list_conversations(
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
pub async fn cloud_list_messages(
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
pub async fn cloud_send_text(
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
pub async fn cloud_send_sticker(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(
            &format!("/api/v1/accounts/{account_id}/send/sticker"),
            &payload,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_send_reaction(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(
            &format!("/api/v1/accounts/{account_id}/send/reaction"),
            &payload,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_send_file(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: Value,
) -> Result<Value, String> {
    authed_client(&base_url, &device_token)?
        .post(
            &format!("/api/v1/accounts/{account_id}/send/file"),
            &payload,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_init_file(
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
pub async fn cloud_upload_file_blob(
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
pub async fn cloud_download_file_blob(
    base_url: String,
    device_token: String,
    file_id: String,
) -> Result<Vec<u8>, String> {
    authed_client(&base_url, &device_token)?
        .get_bytes(&format!("/api/v1/files/{file_id}/blob"))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_base_url_trims_trailing_slash() {
        assert_eq!(
            normalized_base_url("http://127.0.0.1:37880/").unwrap(),
            "http://127.0.0.1:37880"
        );
    }

    #[test]
    fn normalized_base_url_rejects_non_http() {
        assert!(normalized_base_url("file:///tmp/x").is_err());
    }

    #[test]
    fn explicit_token_is_returned_verbatim() {
        assert_eq!(
            resolve_device_token("http://127.0.0.1:37880", "real-token").unwrap(),
            "real-token"
        );
    }
}
