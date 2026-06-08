//! Local browser callback for HTTPS magic-link landing pages.
//!
//! The public email link opens a browser page first. That page sends the magic
//! token to this loopback listener, so Gmail only has to render a normal HTTPS
//! CTA while the installed app still receives the token without copy/paste.

use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{timeout, Duration};

use crate::types::{MagicLinkCallbackPayload, OAuthCallbackPayload};

pub const MAGIC_LINK_CALLBACK_EVENT: &str = "zca-cloud://magic-link-callback";
pub const OAUTH_CALLBACK_EVENT: &str = "zca-cloud://oauth-callback";
pub const MAGIC_LINK_CALLBACK_PORT: u16 = 37886;

const MAGIC_LINK_CALLBACK_PATH: &str = "/auth/magic-link/callback";
const OAUTH_CALLBACK_PATH: &str = "/auth/oauth/callback";
const MAX_REQUEST_BYTES: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq)]
enum CallbackPayload {
    MagicLink(MagicLinkCallbackPayload),
    OAuth(OAuthCallbackPayload),
}

impl CallbackPayload {
    fn base_url(&self) -> &str {
        match self {
            Self::MagicLink(payload) => &payload.base_url,
            Self::OAuth(payload) => &payload.base_url,
        }
    }
}

pub fn start_magic_link_callback_server(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let addr = format!("127.0.0.1:{MAGIC_LINK_CALLBACK_PORT}");
        let listener = match TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(error) => {
                tracing::warn!(%addr, %error, "magic-link callback listener failed to bind");
                return;
            }
        };
        tracing::info!(%addr, "magic-link callback listener started");

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(error) => {
                    tracing::warn!(%error, "magic-link callback accept failed");
                    continue;
                }
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = handle_connection(stream, app).await {
                    tracing::debug!(%error, "magic-link callback request failed");
                }
            });
        }
    });
}

async fn handle_connection(mut stream: TcpStream, app: AppHandle) -> Result<(), String> {
    let mut buf = vec![0_u8; MAX_REQUEST_BYTES];
    let n = timeout(Duration::from_secs(2), stream.read(&mut buf))
        .await
        .map_err(|_| "request timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let raw = String::from_utf8_lossy(&buf[..n]);
    let request = parse_request(&raw).ok_or_else(|| "invalid request".to_string())?;

    if request.method == "OPTIONS" {
        let allowed = request
            .payload
            .as_ref()
            .map(|payload| origin_allowed(request.origin.as_deref(), payload.base_url()))
            .unwrap_or(false);
        let response = if allowed {
            http_response(204, "application/json", "", request.origin.as_deref())
        } else {
            http_response(403, "application/json", "{\"ok\":false}", None)
        };
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if request.method != "GET" {
        let response = http_response(405, "application/json", "{\"ok\":false}", None);
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let Some(payload) = request.payload else {
        let response = http_response(404, "application/json", "{\"ok\":false}", None);
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    };

    if !origin_allowed(request.origin.as_deref(), payload.base_url()) {
        let response = http_response(403, "application/json", "{\"ok\":false}", None);
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    match payload {
        CallbackPayload::MagicLink(payload) => {
            let email_domain = payload.email.split('@').nth(1).unwrap_or("unknown");
            app.emit(MAGIC_LINK_CALLBACK_EVENT, &payload)
                .map_err(|e| e.to_string())?;
            tracing::info!(email_domain, "magic-link callback delivered to app");
        }
        CallbackPayload::OAuth(payload) => {
            app.emit(OAUTH_CALLBACK_EVENT, &payload)
                .map_err(|e| e.to_string())?;
            tracing::info!("oauth callback delivered to app");
        }
    }

    let response = http_response(
        200,
        "application/json",
        "{\"ok\":true}",
        request.origin.as_deref(),
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedRequest {
    method: String,
    origin: Option<String>,
    payload: Option<CallbackPayload>,
}

fn parse_request(raw: &str) -> Option<ParsedRequest> {
    let mut lines = raw.lines();
    let first = lines.next()?;
    let mut parts = first.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?;
    let mut origin = None;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.eq_ignore_ascii_case("origin") {
            origin = Some(value.trim().trim_end_matches('/').to_string());
        }
    }
    Some(ParsedRequest {
        method,
        origin,
        payload: parse_callback_path(path),
    })
}

fn parse_callback_path(path: &str) -> Option<CallbackPayload> {
    let (route, query) = path.split_once('?')?;
    if route == MAGIC_LINK_CALLBACK_PATH {
        let email = query_param(query, "email")?.trim().to_string();
        let token = query_param(query, "token")?.trim().to_string();
        let base_url = normalize_base_url(&query_param(query, "baseUrl")?)?;
        if email.is_empty() || token.is_empty() {
            return None;
        }
        return Some(CallbackPayload::MagicLink(MagicLinkCallbackPayload {
            email,
            token,
            base_url,
        }));
    }
    if route == OAUTH_CALLBACK_PATH {
        let code = query_param(query, "code")?.trim().to_string();
        let base_url = normalize_base_url(&query_param(query, "baseUrl")?)?;
        if code.is_empty() {
            return None;
        }
        return Some(CallbackPayload::OAuth(OAuthCallbackPayload {
            code,
            base_url,
        }));
    }
    None
}

fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        if key != name {
            return None;
        }
        urlencoding::decode(value).ok().map(|v| v.into_owned())
    })
}

fn normalize_base_url(input: &str) -> Option<String> {
    let base = input.trim().trim_end_matches('/');
    if base.starts_with("http://") || base.starts_with("https://") {
        Some(base.to_string())
    } else {
        None
    }
}

fn origin_allowed(origin: Option<&str>, base_url: &str) -> bool {
    let Some(origin) = origin.map(str::trim).filter(|v| !v.is_empty()) else {
        return false;
    };
    origin.trim_end_matches('/') == origin_from_base_url(base_url).as_deref().unwrap_or("")
}

fn origin_from_base_url(base_url: &str) -> Option<String> {
    let (scheme, rest) = base_url.split_once("://")?;
    let host = rest.split('/').next()?.trim_end_matches('/');
    if scheme.is_empty() || host.is_empty() {
        return None;
    }
    Some(format!("{scheme}://{host}"))
}

fn http_response(status: u16, content_type: &str, body: &str, origin: Option<&str>) -> String {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let cors_origin = origin.unwrap_or("*");
    format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: {cors_origin}\r\n\
         Access-Control-Allow-Methods: GET, OPTIONS\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_callback_request() {
        let request = parse_request(
            "GET /auth/magic-link/callback?email=user%40example.com&token=a%20token&baseUrl=https%3A%2F%2Fzca.tuanle.dev HTTP/1.1\r\n\
             Origin: https://zca.tuanle.dev\r\n\r\n",
        )
        .expect("request parses");

        assert_eq!(request.method, "GET");
        assert_eq!(request.origin.as_deref(), Some("https://zca.tuanle.dev"));
        let CallbackPayload::MagicLink(payload) = request.payload.expect("payload parses") else {
            panic!("expected magic-link payload");
        };
        assert_eq!(payload.email, "user@example.com");
        assert_eq!(payload.token, "a token");
        assert_eq!(payload.base_url, "https://zca.tuanle.dev");
        assert!(origin_allowed(request.origin.as_deref(), &payload.base_url));
    }

    #[test]
    fn parses_valid_oauth_callback_request() {
        let request = parse_request(
            "GET /auth/oauth/callback?code=desktop%20code&baseUrl=https%3A%2F%2Fzca.tuanle.dev HTTP/1.1\r\n\
             Origin: https://zca.tuanle.dev\r\n\r\n",
        )
        .expect("request parses");

        let CallbackPayload::OAuth(payload) = request.payload.expect("payload parses") else {
            panic!("expected oauth payload");
        };
        assert_eq!(payload.code, "desktop code");
        assert_eq!(payload.base_url, "https://zca.tuanle.dev");
        assert!(origin_allowed(request.origin.as_deref(), &payload.base_url));
    }

    #[test]
    fn rejects_non_matching_origin() {
        assert!(!origin_allowed(
            Some("https://evil.example"),
            "https://zca.tuanle.dev"
        ));
    }

    #[test]
    fn rejects_missing_origin() {
        assert!(!origin_allowed(None, "https://zca.tuanle.dev"));
        assert!(!origin_allowed(Some(""), "https://zca.tuanle.dev"));
    }

    #[test]
    fn rejects_non_http_base_url() {
        assert!(parse_callback_path(
            "/auth/magic-link/callback?email=user%40example.com&token=t&baseUrl=file%3A%2F%2Ftmp%2Fx"
        )
        .is_none());
        assert!(
            parse_callback_path("/auth/oauth/callback?code=t&baseUrl=file%3A%2F%2Ftmp%2Fx")
                .is_none()
        );
    }
}
