//! `zalo` layer — thin wrapper over the `zca-rust` client.
//!
//! ADR-0003 layer order: `types → config → store → zalo → session → command`.
//! This layer is the only place that talks to `zca-rust`; higher layers
//! (`session`, `command`) depend on this wrapper, never on `zca-rust` directly.
//! It also maps the core `types::Credentials` DTO into `zca-rust`'s credential
//! type so the `types` layer stays free of any `zca-rust` dependency.
//!
//! Security: credentials (imei + cookie + userAgent) are bearer tokens.
//! This module never logs or echoes their values.

pub use zca_rust::listen::Listener;
pub use zca_rust::{Result as ZaloResult, ZaloError, API};

use std::sync::Arc;
use tokio::sync::mpsc;

use zca_rust::apis::send_message::MessageContent as SendContent;
use zca_rust::listen::ListenerEvent;
use zca_rust::models::{Message, MessageContent as ZcaMessageContent, ThreadType};
use zca_rust::zalo::{Cookie as ZcaCookie, Credentials as ZcaCredentials};
use zca_rust::context::Options;
use zca_rust::Zalo;

use crate::types::{AccountProfile, Credentials, IncomingMessage, ThreadKind};

/// Map the core credential DTO into the `zca-rust` credential type.
///
/// Kept inside the `zalo` layer so `types` never depends on `zca-rust`.
fn to_zca_credentials(credentials: &Credentials) -> ZcaCredentials {
    // `ZcaCredentials`/`ZcaCookie` derive `Deserialize` with camelCase; rebuild
    // them via JSON so this mapping stays correct if upstream adds fields.
    let cookies: Vec<ZcaCookie> = credentials
        .cookie
        .iter()
        .filter_map(|c| serde_json::to_value(c).ok().and_then(|v| serde_json::from_value(v).ok()))
        .collect();
    ZcaCredentials {
        imei: credentials.imei.clone(),
        cookie: cookies,
        user_agent: credentials.user_agent.clone(),
        language: credentials.language.clone(),
    }
}

/// Cookie-based login. Returns an authenticated [`API`] facade on success.
///
/// Credentials are validated by `zca-rust` before any network call: empty
/// imei/cookie/userAgent fail fast with [`ZaloError::Api`].
pub async fn login(credentials: Credentials) -> ZaloResult<API> {
    login_with(credentials, false).await
}

/// Like [`login`], but lets the caller opt into `self_listen` so the realtime
/// listener also surfaces messages this account sends (needed to verify a
/// round trip without a second account).
pub async fn login_with(credentials: Credentials, self_listen: bool) -> ZaloResult<API> {
    let options = Options { self_listen, ..Default::default() };
    Zalo::new(Some(options)).login(to_zca_credentials(&credentials)).await
}

/// Log in and return the account's public profile (id + best-effort name).
///
/// `account_id` comes from `getOwnId` (always present after login). The display
/// name is best-effort: a failed profile fetch leaves it `None` rather than
/// failing the whole login.
pub async fn login_profile(credentials: Credentials) -> ZaloResult<AccountProfile> {
    let api = login(credentials).await?;
    Ok(profile_of(&api).await)
}

/// Build the public [`AccountProfile`] for an already-authenticated [`API`].
///
/// `account_id` comes from `getOwnId` (always present after login); the display
/// name is best-effort (a failed fetch leaves it `None`).
pub async fn profile_of(api: &API) -> AccountProfile {
    AccountProfile {
        account_id: api.get_own_id().to_string(),
        display_name: fetch_display_name(api).await,
    }
}

/// Best-effort own display name; returns `None` on any error or empty value.
async fn fetch_display_name(api: &API) -> Option<String> {
    let info = zca_rust::apis::fetch_account_info::fetch_account_info(api.get_context())
        .await
        .ok()?;
    let name = info.profile.display_name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// WebSocket URLs for the realtime listener, taken from the post-login info
/// (`zpw_ws`). Returns an error if the login payload carries none.
fn listener_urls(api: &API) -> ZaloResult<Vec<String>> {
    let urls: Vec<String> = api
        .ctx
        .login_info
        .get("zpw_ws")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if urls.is_empty() {
        return Err(ZaloError::api("login info has no zpw_ws websocket URLs"));
    }
    Ok(urls)
}

/// Map a `zca-rust` text message body to a plain string, if it is text.
fn message_text(content: &ZcaMessageContent) -> Option<String> {
    match content {
        ZcaMessageContent::Text(s) => Some(s.clone()),
        _ => None,
    }
}

/// Map a `zca-rust` `Message` into the core [`IncomingMessage`] DTO.
///
/// Confined to the `zalo` layer so higher layers never see `zca-rust` types.
fn to_incoming_message(account_id: &str, message: &Message) -> IncomingMessage {
    match message {
        Message::User(m) => IncomingMessage {
            account_id: account_id.to_string(),
            thread_id: m.thread_id.clone(),
            thread_kind: ThreadKind::User,
            from_id: m.data.uid_from.clone(),
            from_name: non_empty(&m.data.d_name),
            text: message_text(&m.data.content),
            msg_id: m.data.msg_id.clone(),
            timestamp: m.data.ts.clone(),
            is_self: m.is_self,
        },
        Message::Group(m) => IncomingMessage {
            account_id: account_id.to_string(),
            thread_id: m.thread_id.clone(),
            thread_kind: ThreadKind::Group,
            from_id: m.data.base.uid_from.clone(),
            from_name: non_empty(&m.data.base.d_name),
            text: message_text(&m.data.base.content),
            msg_id: m.data.base.msg_id.clone(),
            timestamp: m.data.base.ts.clone(),
            is_self: m.is_self,
        },
    }
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Start the realtime listener for an authenticated [`API`] and forward each
/// incoming chat message as a core [`IncomingMessage`] over `out`.
///
/// The listener runs in its own tokio task (spawned by `zca-rust`); this
/// function returns once the socket is started. Non-message events (typing,
/// seen, reactions, connection state) are ignored here — `send-text` and later
/// features can widen the bridge. The returned [`Listener`] owns the stop
/// handle; drop or call `.stop()` to shut the socket down.
pub async fn start_message_listener(
    api: Arc<API>,
    out: mpsc::Sender<IncomingMessage>,
) -> ZaloResult<Listener> {
    let urls = listener_urls(&api)?;
    let account_id = api.get_own_id().to_string();
    let (mut listener, mut rx) = Listener::new(api.ctx.clone(), urls);
    listener.start(true).await?;

    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let ListenerEvent::Message(boxed) = event {
                let incoming = to_incoming_message(&account_id, &boxed);
                if out.send(incoming).await.is_err() {
                    break; // receiver dropped — stop bridging
                }
            }
        }
    });

    Ok(listener)
}

/// Send a plain-text message to a user thread and return the new message id.
///
/// Thin wrapper over `zca-rust` `send_message`; the `command` layer maps the
/// core thread-kind DTO to `ThreadType` before calling this.
pub async fn send_text(api: &API, thread_id: &str, text: &str) -> ZaloResult<String> {
    let content = SendContent {
        msg: text.to_string(),
        styles: None,
        urgency: None,
        quote: None,
        mentions: None,
        ttl: None,
    };
    let resp = api.send_message(&content, thread_id, ThreadType::User).await?;
    Ok(resp.message.map(|m| m.msg_id).unwrap_or_default())
}

/// Resolve a user's uid from a phone number (best-effort; tolerates Zalo's
/// "not a contact" code 216 internally). Used by live tests to address a real
/// recipient without hard-coding ids.
#[cfg(test)]
async fn find_user_uid(api: &API, phone: &str) -> ZaloResult<String> {
    use zca_rust::models::AvatarSize;
    let user = api.find_user(phone, AvatarSize::Small).await?;
    Ok(user.uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Credentials;

    fn blank_credentials() -> Credentials {
        Credentials {
            imei: String::new(),
            cookie: Vec::new(),
            user_agent: String::new(),
            language: "vi".to_string(),
        }
    }

    /// Empty credentials must fail fast (offline) instead of attempting a
    /// network login — proves the wrapper is wired to `zca-rust` validation.
    #[tokio::test]
    async fn login_rejects_empty_credentials() {
        // `API` does not implement `Debug`, so match instead of `expect_err`.
        match login(blank_credentials()).await {
            Ok(_) => panic!("empty credentials must not produce a session"),
            Err(err) => assert!(matches!(err, ZaloError::Api { .. }), "expected API error, got {err}"),
        }
    }

    /// Same guard for the profile path.
    #[tokio::test]
    async fn login_profile_rejects_empty_credentials() {
        let err = login_profile(blank_credentials()).await.expect_err("empty creds must error");
        assert!(matches!(err, ZaloError::Api { .. }), "expected API error, got {err}");
    }

    /// Live single-login smoke. Ignored by default: it performs a REAL network
    /// login and requires a populated `.zalo-cred.json` (gitignored) at the repo
    /// root. Run explicitly:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored single_login_live
    /// Prints only non-secret facts (uid length, whether a display name exists);
    /// it never echoes imei/cookie/userAgent.
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; performs a live network login"]
    async fn single_login_live() {
        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root from .zalo-cred.example.json");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials.validate().expect(".zalo-cred.json is missing required fields");

        let profile = login_profile(credentials).await.expect("live login failed");

        assert!(!profile.account_id.is_empty(), "account_id must be non-empty after login");
        // Non-secret diagnostics only.
        println!(
            "single_login_live OK: uid_len={} has_display_name={}",
            profile.account_id.len(),
            profile.display_name.is_some()
        );
    }

    /// Live listener round trip. Ignored by default. Logs in with self_listen,
    /// starts the message bridge, sends a unique marker to the account's own
    /// "My Cloud" thread (own uid), and asserts the bridge surfaces it as a
    /// core IncomingMessage. No third party is contacted. Run explicitly:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored listener_receives_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; performs a live websocket round trip"]
    async fn listener_receives_live() {
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials.validate().expect(".zalo-cred.json is missing required fields");

        // self_listen so our own outgoing message is surfaced by the listener.
        let api = Arc::new(login_with(credentials, true).await.expect("live login failed"));
        let own_id = api.get_own_id().to_string();

        // Resolve the test recipient by phone (Lê Anh Tuấn, authorized by the
        // project owner). self_listen means our own outbound message comes back
        // as a real inbound websocket event we can match on.
        let recipient_phone =
            std::env::var("ZALO_TEST_PHONE").unwrap_or_else(|_| "0359969964".to_string());
        let thread_id = find_user_uid(&api, &recipient_phone)
            .await
            .expect("could not resolve test recipient by phone");

        let (tx, mut rx) = mpsc::channel::<IncomingMessage>(16);
        let _listener = start_message_listener(api.clone(), tx)
            .await
            .expect("listener failed to start");

        // Give the socket a moment to complete the cipher handshake.
        tokio::time::sleep(Duration::from_secs(3)).await;

        let marker = format!(
            "zca-desktop listener test {}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
        );
        send_text(&api, &thread_id, &marker).await.expect("send marker failed");

        let captured = tokio::time::timeout(Duration::from_secs(20), async {
            while let Some(msg) = rx.recv().await {
                if msg.text.as_deref() == Some(marker.as_str()) {
                    return Some(msg);
                }
            }
            None
        })
        .await
        .ok()
        .flatten();

        let msg = captured.expect("listener did not surface the sent marker within 20s");
        assert!(!msg.msg_id.is_empty(), "captured message must have a msg_id");
        assert_eq!(msg.account_id, own_id, "event tagged with wrong account");
        println!(
            "listener_receives_live OK: matched marker, thread_kind={:?} msg_id_len={} is_self={}",
            msg.thread_kind,
            msg.msg_id.len(),
            msg.is_self
        );
    }

    /// Live send-text smoke. Ignored by default. Logs in and sends ONE real text
    /// message to the authorized recipient (Lê Anh Tuấn, resolved by phone),
    /// asserting a non-empty message id comes back. Run explicitly:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored send_text_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; sends ONE real message to the authorized recipient"]
    async fn send_text_live() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials.validate().expect(".zalo-cred.json is missing required fields");

        let api = login(credentials).await.expect("live login failed");

        let recipient_phone =
            std::env::var("ZALO_TEST_PHONE").unwrap_or_else(|_| "0359969964".to_string());
        let thread_id = find_user_uid(&api, &recipient_phone)
            .await
            .expect("could not resolve recipient by phone");

        let marker = format!(
            "zca-desktop send-text test {}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
        );
        let msg_id = send_text(&api, &thread_id, &marker).await.expect("send_text failed");

        assert!(!msg_id.is_empty(), "send_text must return a message id");
        println!("send_text_live OK: delivered, msg_id_len={}", msg_id.len());
    }
}
