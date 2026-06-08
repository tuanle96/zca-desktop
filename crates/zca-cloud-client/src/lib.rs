//! Tauri-agnostic HTTP/SSE client to the zca cloud server.
//!
//! This is the SINGLE Rust home for the `/api/v1` contract: the desktop core
//! (`command/cloud.rs`) and the mobile core both build thin Tauri command
//! wrappers over it. It is UI-agnostic — no Tauri, no keychain. Callers pass the
//! already-resolved device token (loaded from the OS keychain by the Tauri layer)
//! and get back `serde_json::Value` (the desktop/mobile commands deserialize into
//! their typed DTOs as needed). Realtime is exposed as a raw SSE `Response` plus
//! the shared `drain_sse_events` frame parser, so the connection lifecycle (event
//! emission) stays in the app layer.

use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    #[error("cloud base_url must start with http:// or https://")]
    InvalidBaseUrl,
    #[error("cloud request failed: {0}")]
    Transport(String),
    #[error("cloud request failed: status={status}, message={message}")]
    Status { status: u16, message: String },
    #[error("invalid cloud response: {0}")]
    Decode(String),
}

pub type Result<T> = std::result::Result<T, CloudError>;

/// A client bound to one cloud server `base_url`, optionally carrying a device
/// token (sent as `Authorization: Bearer`).
#[derive(Clone)]
pub struct CloudClient {
    base_url: String,
    device_token: Option<String>,
    http: reqwest::Client,
}

impl CloudClient {
    /// Anonymous client (health, magic-link). Validates the base URL is http(s).
    pub fn new(base_url: &str) -> Result<Self> {
        Ok(Self {
            base_url: validate_base(base_url)?,
            device_token: None,
            http: reqwest::Client::new(),
        })
    }

    /// Authenticated client carrying a resolved device token.
    pub fn with_token(base_url: &str, device_token: &str) -> Result<Self> {
        let mut client = Self::new(base_url)?;
        client.device_token = Some(device_token.to_string());
        Ok(client)
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Join `base_url` with a request path (path may include the `/api/v1` prefix).
    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, ensure_leading_slash(path))
    }

    fn auth(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.device_token {
            Some(token) => builder.bearer_auth(token),
            None => builder,
        }
    }

    async fn send(&self, builder: reqwest::RequestBuilder) -> Result<Value> {
        let res = self
            .auth(builder)
            .send()
            .await
            .map_err(|e| CloudError::Transport(e.to_string()))?;
        read_json(res).await
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.send(self.http.get(self.url(path))).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value> {
        self.send(self.http.post(self.url(path)).json(body)).await
    }

    /// POST with no body (e.g. `accounts/qr/start`).
    pub async fn post_empty(&self, path: &str) -> Result<Value> {
        self.send(self.http.post(self.url(path))).await
    }

    pub async fn delete(&self, path: &str) -> Result<Value> {
        self.send(self.http.delete(self.url(path))).await
    }

    /// POST a raw body (file blob upload).
    pub async fn post_bytes(&self, path: &str, bytes: Vec<u8>) -> Result<Value> {
        self.send(self.http.post(self.url(path)).body(bytes)).await
    }

    /// GET a raw body (file blob download).
    pub async fn get_bytes(&self, path: &str) -> Result<Vec<u8>> {
        let res = self
            .auth(self.http.get(self.url(path)))
            .send()
            .await
            .map_err(|e| CloudError::Transport(e.to_string()))?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(CloudError::Status {
                status: status.as_u16(),
                message: format!("body_len={}", body.len()),
            });
        }
        res.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| CloudError::Decode(e.to_string()))
    }

    /// Open an authenticated SSE GET. Returns the raw `Response` WITHOUT a status
    /// check, so callers can distinguish connect errors from HTTP-status errors;
    /// consume via `Response::bytes_stream()` + [`drain_sse_events`].
    pub async fn open_sse(&self, path: &str) -> Result<reqwest::Response> {
        self.auth(self.http.get(self.url(path)))
            .send()
            .await
            .map_err(|e| CloudError::Transport(e.to_string()))
    }

    // ---- Typed-ish convenience for unauthenticated/simple endpoints ----

    /// `GET /health` (not under `/api/v1`).
    pub async fn health(&self) -> Result<Value> {
        self.send(self.http.get(format!("{}/health", self.base_url)))
            .await
    }

    pub async fn request_magic_link(&self, email: &str) -> Result<Value> {
        self.post(
            "/api/v1/auth/magic-link/request",
            &serde_json::json!({ "email": email }),
        )
        .await
    }

    pub async fn oauth_providers(&self) -> Result<Value> {
        self.get("/api/v1/auth/oauth/providers").await
    }

    pub async fn verify_magic_link(
        &self,
        email: &str,
        token: &str,
        device_name: &str,
        recovery_key: Option<&str>,
    ) -> Result<Value> {
        self.post(
            "/api/v1/auth/magic-link/verify",
            &serde_json::json!({
                "email": email,
                "token": token,
                "deviceName": device_name,
                "recoveryKey": recovery_key,
            }),
        )
        .await
    }

    pub async fn verify_oauth_desktop_code(&self, code: &str) -> Result<Value> {
        self.post(
            "/api/v1/auth/oauth/device/verify",
            &serde_json::json!({ "code": code }),
        )
        .await
    }

    pub async fn list_accounts(&self) -> Result<Value> {
        self.get("/api/v1/accounts").await
    }
}

/// Extract complete SSE frames (`…\n\n`) from `buffer`, returning the parsed JSON
/// of each `data:` line. Any partial trailing frame is left in `buffer`.
pub fn drain_sse_events(buffer: &mut String) -> Vec<Value> {
    let mut events = Vec::new();
    while let Some(idx) = buffer.find("\n\n") {
        let frame = buffer[..idx].to_string();
        *buffer = buffer[idx + 2..].to_string();
        for line in frame.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(json) = serde_json::from_str::<Value>(data.trim()) {
                    events.push(json);
                }
            }
        }
    }
    events
}

async fn read_json(res: reqwest::Response) -> Result<Value> {
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| v.get("error").and_then(|m| m.as_str()))
                    .map(str::to_string)
            })
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| format!("body_len={}", body.len()));
        return Err(CloudError::Status {
            status: status.as_u16(),
            message,
        });
    }
    let body = res
        .text()
        .await
        .map_err(|e| CloudError::Transport(e.to_string()))?;
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&body).map_err(|e| CloudError::Decode(e.to_string()))
}

fn validate_base(base_url: &str) -> Result<String> {
    let base = base_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err(CloudError::InvalidBaseUrl);
    }
    Ok(base.to_string())
}

fn ensure_leading_slash(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_validated_and_normalized() {
        assert!(CloudClient::new("file:///tmp/x").is_err());
        let client = CloudClient::new("http://127.0.0.1:37880/").unwrap();
        assert_eq!(client.base_url(), "http://127.0.0.1:37880");
        assert_eq!(
            client.url("/api/v1/accounts"),
            "http://127.0.0.1:37880/api/v1/accounts"
        );
        // A path without a leading slash is still joined cleanly.
        assert_eq!(client.url("health"), "http://127.0.0.1:37880/health");
    }

    #[test]
    fn drain_sse_extracts_complete_frames_only() {
        let mut buf = String::from("data: {\"type\":\"a\"}\n\ndata: {\"type\":\"b\"}\n\ndata: {\"par");
        let events = drain_sse_events(&mut buf);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "a");
        assert_eq!(events[1]["type"], "b");
        // The partial trailing frame remains buffered.
        assert_eq!(buf, "data: {\"par");
    }
}
