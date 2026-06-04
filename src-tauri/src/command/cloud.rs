//! Cloud SaaS client boundary for the desktop app.
//!
//! Cloud SaaS is the desktop app's active session path. These commands let the
//! Svelte UI talk to the hosted session backend (ADR-0006) without moving Zalo
//! credentials into the webview. Cloud device tokens are SaaS bearer tokens;
//! callers must store them carefully, but they are not Zalo credential triples.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const CLOUD_EVENT: &str = "zca-cloud://event";
pub const CLOUD_DEVICE_TOKEN_KEYCHAIN: &str = "__keychain__";
const CLOUD_KEYRING_SERVICE: &str = "com.zca-desktop.cloud-device-session";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMagicLinkResponse {
    pub sent: bool,
    pub expires_in_secs: u64,
    #[serde(default)]
    pub dev_magic_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudVerifyResponse {
    pub user_id: String,
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    pub recovery_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDevice {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub revoked_at: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceRegisterResponse {
    pub device_id: String,
    pub device_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceSessionView {
    pub base_url: String,
    pub has_device_token: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCloudDeviceSession {
    device_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    pub id: String,
    pub zalo_account_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    pub state: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSendStickerPayload {
    pub thread_id: String,
    pub sticker_id: i64,
    pub cat_id: i64,
    pub sticker_type: i64,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSendReactionPayload {
    pub thread_id: String,
    pub msg_id: String,
    pub cli_msg_id: String,
    pub icon: String,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

fn endpoint(base_url: &str, path: &str) -> Result<String, String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("cloud base_url must start with http:// or https://".to_string());
    }
    Ok(format!("{base}{path}"))
}

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

async fn parse_response<T: for<'de> Deserialize<'de>>(res: reqwest::Response) -> Result<T, String> {
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "cloud request failed: status={status}, body_len={}",
            body.len()
        ));
    }
    res.json::<T>()
        .await
        .map_err(|e| format!("invalid cloud response: {e}"))
}

#[tauri::command]
pub async fn cloud_load_device_session(
    base_url: String,
) -> Result<Option<CloudDeviceSessionView>, String> {
    let base = normalized_base_url(&base_url)?;
    Ok(
        load_cloud_device_token(&base)?.map(|_| CloudDeviceSessionView {
            base_url: base,
            has_device_token: true,
        }),
    )
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
    let url = endpoint(&base_url, "/api/v1/realtime")?;
    let device_token = resolve_device_token(&base_url, &device_token)?;
    tokio::spawn(async move {
        let res = match reqwest::Client::new()
            .get(url)
            .bearer_auth(device_token)
            .send()
            .await
        {
            Ok(res) => res,
            Err(e) => {
                let message = e.to_string();
                let _ = app.emit(
                    CLOUD_EVENT,
                    serde_json::json!({ "type": "error", "message": message }),
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
            while let Some(idx) = buffer.find("\n\n") {
                let frame = buffer[..idx].to_string();
                buffer = buffer[idx + 2..].to_string();
                for line in frame.lines() {
                    if let Some(data) = line.strip_prefix("data:") {
                        let payload = data.trim();
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(payload) {
                            let _ = app.emit(CLOUD_EVENT, json);
                        }
                    }
                }
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
pub async fn cloud_request_magic_link(
    base_url: String,
    email: String,
) -> Result<CloudMagicLinkResponse, String> {
    let url = endpoint(&base_url, "/api/v1/auth/magic-link/request")?;
    let res = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_verify_magic_link(
    base_url: String,
    email: String,
    token: String,
    device_name: String,
    recovery_key: Option<String>,
) -> Result<CloudVerifyResponse, String> {
    let url = endpoint(&base_url, "/api/v1/auth/magic-link/verify")?;
    let res = reqwest::Client::new()
        .post(url)
        .json(&serde_json::json!({
            "email": email,
            "token": token,
            "deviceName": device_name,
            "recoveryKey": recovery_key
        }))
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    let mut verified: CloudVerifyResponse = parse_response(res).await?;
    save_cloud_device_token(&base_url, &verified.device_token)?;
    verified.device_token = CLOUD_DEVICE_TOKEN_KEYCHAIN.to_string();
    Ok(verified)
}

#[tauri::command]
pub async fn cloud_register_device(
    base_url: String,
    device_token: String,
    name: String,
    recovery_key: String,
) -> Result<CloudDeviceRegisterResponse, String> {
    let url = endpoint(&base_url, "/api/v1/devices")?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "name": name, "recoveryKey": recovery_key }))
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    let mut registered: CloudDeviceRegisterResponse = parse_response(res).await?;
    save_cloud_device_token(&base_url, &registered.device_token)?;
    registered.device_token = CLOUD_DEVICE_TOKEN_KEYCHAIN.to_string();
    Ok(registered)
}

#[tauri::command]
pub async fn cloud_list_devices(
    base_url: String,
    device_token: String,
) -> Result<Vec<CloudDevice>, String> {
    let url = endpoint(&base_url, "/api/v1/devices")?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_revoke_device(
    base_url: String,
    device_token: String,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let url = endpoint(&base_url, &format!("/api/v1/devices/{device_id}"))?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .delete(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_list_accounts(
    base_url: String,
    device_token: String,
) -> Result<Vec<CloudAccount>, String> {
    let url = endpoint(&base_url, "/api/v1/accounts")?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_start_account_qr(
    base_url: String,
    device_token: String,
) -> Result<serde_json::Value, String> {
    let url = endpoint(&base_url, "/api/v1/accounts/qr/start")?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_get_qr_status(
    base_url: String,
    device_token: String,
    flow_id: String,
) -> Result<serde_json::Value, String> {
    let url = endpoint(&base_url, &format!("/api/v1/accounts/qr/{flow_id}"))?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_delete_account(
    base_url: String,
    device_token: String,
    account_id: String,
) -> Result<serde_json::Value, String> {
    let url = endpoint(&base_url, &format!("/api/v1/accounts/{account_id}"))?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .delete(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_list_conversations(
    base_url: String,
    device_token: String,
    account_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = account_id
        .map(|id| format!("/api/v1/conversations?accountId={id}"))
        .unwrap_or_else(|| "/api/v1/conversations".to_string());
    let url = endpoint(&base_url, &path)?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_list_messages(
    base_url: String,
    device_token: String,
    conversation_id: String,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let url = endpoint(
        &base_url,
        &format!(
            "/api/v1/conversations/{conversation_id}/messages?limit={}",
            limit.unwrap_or(100)
        ),
    )?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_send_text(
    base_url: String,
    device_token: String,
    account_id: String,
    thread_id: String,
    text: String,
    thread_kind: Option<String>,
) -> Result<serde_json::Value, String> {
    let url = endpoint(
        &base_url,
        &format!("/api/v1/accounts/{account_id}/send/text"),
    )?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(
            &serde_json::json!({ "threadId": thread_id, "text": text, "threadKind": thread_kind }),
        )
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_send_sticker(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: CloudSendStickerPayload,
) -> Result<serde_json::Value, String> {
    let url = endpoint(
        &base_url,
        &format!("/api/v1/accounts/{account_id}/send/sticker"),
    )?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_send_reaction(
    base_url: String,
    device_token: String,
    account_id: String,
    payload: CloudSendReactionPayload,
) -> Result<serde_json::Value, String> {
    let url = endpoint(
        &base_url,
        &format!("/api/v1/accounts/{account_id}/send/reaction"),
    )?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_init_file(
    base_url: String,
    device_token: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let url = endpoint(&base_url, "/api/v1/files/init")?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_upload_file_blob(
    base_url: String,
    device_token: String,
    file_id: String,
    bytes: Vec<u8>,
) -> Result<serde_json::Value, String> {
    let url = endpoint(&base_url, &format!("/api/v1/files/{file_id}/blob"))?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    parse_response(res).await
}

#[tauri::command]
pub async fn cloud_download_file_blob(
    base_url: String,
    device_token: String,
    file_id: String,
) -> Result<Vec<u8>, String> {
    let url = endpoint(&base_url, &format!("/api/v1/files/{file_id}/blob"))?;
    let token = resolve_device_token(&base_url, &device_token)?;
    let res = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("cloud request failed: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "cloud request failed: status={status}, body_len={}",
            body.len()
        ));
    }
    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("invalid cloud file response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_requires_http_base_url() {
        assert!(endpoint("http://127.0.0.1:37880", "/health").is_ok());
        assert!(endpoint("file:///tmp/x", "/health").is_err());
    }

    #[test]
    fn normalized_base_url_trims_trailing_slash() {
        assert_eq!(
            normalized_base_url("http://127.0.0.1:37880/").unwrap(),
            "http://127.0.0.1:37880"
        );
    }
}
