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

use reqwest::cookie::{CookieStore, Jar};
use zca_rust::apis::login_qr::{login_qr, LoginQREvent, LoginQROptions, LoginQRResult};
use zca_rust::apis::send_message::MessageContent as SendContent;
use zca_rust::apis::send_sticker::SendStickerPayload;
use zca_rust::context::Options;
use zca_rust::crypto::generate_zalo_uuid;
use zca_rust::listen::ListenerEvent;
use zca_rust::models::{Message, MessageContent as ZcaMessageContent, Reactions, ThreadType};
use zca_rust::zalo::{Cookie as ZcaCookie, Credentials as ZcaCredentials};
use zca_rust::Zalo;

use crate::types::{
    AccountProfile, Contact, Cookie, Credentials, Group, IncomingMessage, LinkPreview,
    QrLoginEvent, QuoteInput, QuoteRef, ReactionEvent, ReactionIcon, Sticker, ThreadKind,
    UndoEvent,
};

/// Default desktop browser User-Agent for the QR login flow.
///
/// Mirrors the upstream `zca-js` default so the generated device identity
/// (`imei`, derived from the UA) and the login requests look like a normal
/// desktop browser. The same UA is stored in the resulting [`Credentials`] so
/// later cookie-based logins stay consistent with the device that scanned.
const DEFAULT_QR_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";

/// Zalo hosts whose cookies make up an authenticated session. The QR cookie jar
/// is opaque (reqwest only exposes `name=value` per URL), so we read each host
/// and merge the pairs when rebuilding [`Credentials`]. Auth cookies can sit on
/// the apex `.zalo.me` or on specific subdomains (the login call itself goes to
/// `wpa.chat.zalo.me`), so we query a broad host set and de-duplicate by name.
const ZALO_COOKIE_HOSTS: [&str; 5] = [
    "https://zalo.me/",
    "https://chat.zalo.me/",
    "https://wpa.chat.zalo.me/",
    "https://id.zalo.me/",
    "https://jr.chat.zalo.me/",
];

/// How long a generated QR stays valid before the core aborts the wait and
/// emits `Expired`. Matches the upstream client's 100s window. Surfaced to the
/// UI in [`QrLoginEvent::Generated`] so the countdown stays in sync.
const QR_VALIDITY_SECS: u64 = 100;

/// Map the core credential DTO into the `zca-rust` credential type.
///
/// Kept inside the `zalo` layer so `types` never depends on `zca-rust`.
fn to_zca_credentials(credentials: &Credentials) -> ZcaCredentials {
    // `ZcaCredentials`/`ZcaCookie` derive `Deserialize` with camelCase; rebuild
    // them via JSON so this mapping stays correct if upstream adds fields.
    let cookies: Vec<ZcaCookie> = credentials
        .cookie
        .iter()
        .filter_map(|c| {
            serde_json::to_value(c)
                .ok()
                .and_then(|v| serde_json::from_value(v).ok())
        })
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
    let options = Options {
        self_listen,
        ..Default::default()
    };
    Zalo::new(Some(options))
        .login(to_zca_credentials(&credentials))
        .await
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

/// Run the interactive QR-code login flow (ADR-0004).
///
/// Drives `zca-rust`'s `login_qr`, forwarding each stage to the UI as a
/// non-secret [`QrLoginEvent`] over `events`. On success it assembles a
/// reusable [`Credentials`] triple from the QR cookie jar plus a freshly
/// generated, stable device `imei` and the User-Agent used for the flow.
///
/// Security: the returned [`Credentials`] (imei + cookie + user_agent) is a
/// bearer token. It stays in the core — only the non-secret display events
/// cross `events` to the UI. The caller persists/uses the triple; it is never
/// serialized back across the IPC boundary.
pub async fn run_qr_login(events: mpsc::Sender<QrLoginEvent>) -> ZaloResult<Credentials> {
    let user_agent = DEFAULT_QR_USER_AGENT.to_string();
    let options = LoginQROptions {
        user_agent: user_agent.clone(),
        qr_timeout: std::time::Duration::from_secs(QR_VALIDITY_SECS),
    };

    // `callback` is sync (`FnMut`); forward each stage to the async channel with
    // a non-blocking send. Dropping a display event is non-fatal (the flow keeps
    // running) — only the final credential matters for correctness.
    let result: LoginQRResult = login_qr(options, |event| {
        if let Some(mapped) = map_qr_event(&event) {
            let _ = events.try_send(mapped);
        }
    })
    .await?;

    let credentials = credentials_from_qr(&result, &user_agent)?;
    let _ = events.try_send(QrLoginEvent::Success);
    Ok(credentials)
}

/// Map a `zca-rust` `LoginQREvent` to a non-secret [`QrLoginEvent`] for the UI.
///
/// `GotLoginInfo` (which would carry token values) is deliberately dropped here
/// — the credential triple is assembled in the core, never surfaced to the UI.
fn map_qr_event(event: &LoginQREvent) -> Option<QrLoginEvent> {
    match event {
        LoginQREvent::QRCodeGenerated { image, .. } => Some(QrLoginEvent::Generated {
            image: image.clone(),
            expires_in_secs: QR_VALIDITY_SECS,
        }),
        LoginQREvent::QRCodeScanned {
            avatar,
            display_name,
        } => Some(QrLoginEvent::Scanned {
            display_name: display_name.clone(),
            avatar: avatar.clone(),
        }),
        LoginQREvent::QRCodeDeclined { .. } => Some(QrLoginEvent::Declined),
        LoginQREvent::QRCodeExpired => Some(QrLoginEvent::Expired),
        // Token-bearing event: kept in the core, never forwarded to the UI.
        LoginQREvent::GotLoginInfo { .. } => None,
    }
}

/// Assemble a reusable [`Credentials`] from a successful QR login (ADR-0004).
///
/// The QR flow yields cookies (in an opaque jar) + the account's public profile
/// but no device identity, so we generate a stable `imei` with
/// `generate_zalo_uuid` (`randomUUID + "-" + MD5(user_agent)`, matching the
/// upstream client) and pair it with the cookies read back out of the jar.
fn credentials_from_qr(result: &LoginQRResult, user_agent: &str) -> ZaloResult<Credentials> {
    let cookie = cookies_from_jar(&result.cookie_jar);

    // Diagnostics: record which cookie NAMES the QR jar yielded (values are
    // redacted by the capture sink). The Zalo session needs specific auth
    // cookies (e.g. zpsid/zpw_sek); a missing/short set here is the likely
    // cause of a downstream `missing zpw_enk` at cookie-login.
    let cookie_names: Vec<&str> = cookie.iter().map(|c| c.name.as_str()).collect();
    tracing::info!(count = cookie.len(), names = ?cookie_names, "qr: cookies extracted from jar");
    crate::config::logging::capture_raw(
        "qr.cookies_from_jar",
        &serde_json::json!({ "count": cookie.len(), "names": cookie_names }).to_string(),
    );

    if cookie.is_empty() {
        return Err(ZaloError::api("QR login returned no session cookies"));
    }
    let credentials = Credentials {
        imei: generate_zalo_uuid(user_agent),
        cookie,
        user_agent: user_agent.to_string(),
        language: "vi".to_string(),
    };
    // Defensive: reuse the same validation the cookie-import path enforces.
    credentials
        .validate()
        .map_err(|e| ZaloError::api(e.to_string()))?;
    Ok(credentials)
}

/// Read cookies back out of the QR-login cookie jar into core [`Cookie`] DTOs.
///
/// reqwest's `Jar` is opaque (only `CookieStore::cookies(url) -> name=value`
/// pairs are exposed), so we query each known Zalo host and merge the pairs,
/// de-duplicating by cookie name. Domains are recorded per host so the
/// re-login path can repopulate the jar.
fn cookies_from_jar(jar: &Arc<Jar>) -> Vec<Cookie> {
    let mut seen = std::collections::HashSet::new();
    let mut cookies = Vec::new();
    for host in ZALO_COOKIE_HOSTS {
        let url = match host.parse::<reqwest::Url>() {
            Ok(u) => u,
            Err(_) => continue,
        };
        let Some(header) = jar.cookies(&url) else {
            continue;
        };
        let Ok(header_str) = header.to_str() else {
            continue;
        };
        for pair in header_str.split(';') {
            let pair = pair.trim();
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if name.is_empty() || !seen.insert(name.to_string()) {
                continue;
            }
            cookies.push(Cookie {
                // Zalo session cookies are apex-scoped; tag them `.zalo.me` so
                // re-population attaches them to every *.zalo.me request the
                // login flow makes (id/wpa/chat/...), not just one subdomain.
                domain: ".zalo.me".to_string(),
                name: name.to_string(),
                value: value.trim().to_string(),
                path: "/".to_string(),
                expiration_date: None,
                host_only: false,
                http_only: false,
                same_site: None,
                secure: true,
                session: false,
                store_id: None,
            });
        }
    }
    cookies
}

/// Build the public [`AccountProfile`] for an already-authenticated [`API`].
///
/// `account_id` comes from `getOwnId` (always present after login); the display
/// name is best-effort (a failed fetch leaves it `None`).
pub async fn profile_of(api: &API) -> AccountProfile {
    let (display_name, avatar) = fetch_profile_fields(api).await;
    AccountProfile {
        account_id: api.get_own_id().to_string(),
        display_name,
        avatar,
    }
}

/// Best-effort own display name + avatar URL. Returns `(None, None)` on any
/// error; an empty value for either field becomes `None`.
async fn fetch_profile_fields(api: &API) -> (Option<String>, Option<String>) {
    let Ok(info) = zca_rust::apis::fetch_account_info::fetch_account_info(api.get_context()).await
    else {
        return (None, None);
    };
    (
        non_empty(&info.profile.display_name),
        non_empty(&info.profile.avatar),
    )
}

/// WebSocket URLs for the realtime listener, taken from the post-login info
/// (`zpw_ws`). Returns an error if the login payload carries none.
fn listener_urls(api: &API) -> ZaloResult<Vec<String>> {
    let urls: Vec<String> = api
        .ctx
        .login_info
        .get("zpw_ws")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
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

/// Zalo emoticon CDN base for rendering a sticker by its id. The `size`
/// produces a chat-bubble-sized render; this host is allowlisted in the app
/// CSP (`img-src ... https://zalo-api.zadn.vn`). Centralized so the URL shape
/// lives in one place (also used by the picker via [`to_sticker`]).
fn sticker_image_url(sticker_id: i64) -> String {
    format!("https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid={sticker_id}&size=130")
}

/// Extract a [`Sticker`] from an incoming message whose `msgType` is
/// `chat.sticker`. Returns `None` for any other message type.
///
/// Sticker messages arrive with a JSON object body (not plain text), so the
/// untagged [`ZcaMessageContent`] is `Attachment`/`Other`. We re-serialize the
/// content to a JSON value and read `id`/`catId`/`type` (the same fields Zalo
/// uses to re-send a sticker), then build the renderable CDN URL. Confined to
/// the `zalo` layer so higher layers never see `zca-rust` types.
fn sticker_from_content(msg_type: &str, content: &ZcaMessageContent) -> Option<Sticker> {
    if msg_type != "chat.sticker" {
        return None;
    }
    let value = serde_json::to_value(content).ok()?;
    // The numeric ids can arrive as JSON numbers or strings; accept both.
    let as_i64 = |v: &serde_json::Value| -> Option<i64> {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    };
    let id = value.get("id").and_then(as_i64)?;
    let cat_id = value.get("catId").and_then(as_i64).unwrap_or(0);
    let sticker_type = value.get("type").and_then(as_i64).unwrap_or(0);
    if id == 0 {
        return None;
    }
    Some(Sticker {
        id,
        cat_id,
        sticker_type,
        url: sticker_image_url(id),
    })
}

/// Extract a [`LinkPreview`] from an attachment-type message content when the
/// message type is `chat.link`. Returns `None` for non-link messages.
fn link_from_content(msg_type: &str, content: &ZcaMessageContent) -> Option<LinkPreview> {
    if msg_type != "chat.link" {
        return None;
    }
    match content {
        ZcaMessageContent::Attachment(att) => {
            if att.href.is_empty() {
                return None;
            }
            Some(LinkPreview {
                href: att.href.clone(),
                title: non_empty(&att.title),
                description: non_empty(&att.description),
                thumb: non_empty(&att.thumb),
            })
        }
        _ => None,
    }
}

/// Map a `zca-rust` incoming `Quote` into a core [`QuoteRef`]. Confined to the
/// `zalo` layer so `types` stays clean.
fn to_quote_ref(q: &zca_rust::models::Quote) -> QuoteRef {
    QuoteRef {
        owner_id: q.owner_id.clone(),
        from_d: q.from_d.clone(),
        global_msg_id: q.global_msg_id,
        cli_msg_id: q.cli_msg_id,
        msg: q.msg.clone(),
        cli_msg_type: q.cli_msg_type,
        ts: q.ts,
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
            sticker: sticker_from_content(&m.data.msg_type, &m.data.content),
            reaction: None,
            quote: m.data.quote.as_ref().map(to_quote_ref),
            link: link_from_content(&m.data.msg_type, &m.data.content),
            undo: None,
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
            sticker: sticker_from_content(&m.data.base.msg_type, &m.data.base.content),
            reaction: None,
            quote: m.data.base.quote.as_ref().map(to_quote_ref),
            link: link_from_content(&m.data.base.msg_type, &m.data.base.content),
            undo: None,
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
            match event {
                ListenerEvent::Message(boxed) => {
                    let incoming = to_incoming_message(&account_id, &boxed);
                    if out.send(incoming).await.is_err() {
                        break; // receiver dropped — stop bridging
                    }
                }
                ListenerEvent::Reaction(reaction) => {
                    if let Some(icon) = icon_from_zalo(&reaction.data.content.r_icon) {
                        let thread_id = reaction.thread_id.clone();
                        let msg_id = reaction.data.msg_id.clone();
                        let uid_from = reaction.data.uid_from.clone();
                        let d_name = reaction.data.d_name.clone();
                        let ts = reaction.data.ts.clone();
                        let is_group = reaction.is_group;
                        let is_self = reaction.is_self;

                        let incoming = IncomingMessage {
                            account_id: account_id.clone(),
                            thread_id: thread_id.clone(),
                            thread_kind: if is_group {
                                ThreadKind::Group
                            } else {
                                ThreadKind::User
                            },
                            from_id: uid_from.clone(),
                            from_name: d_name.clone(),
                            text: None,
                            sticker: None,
                            reaction: Some(ReactionEvent {
                                thread_id,
                                msg_id,
                                uid_from,
                                d_name,
                                icon: icon.emoji().to_string(),
                                is_self,
                                is_group,
                            }),
                            quote: None,
                            link: None,
                            undo: None,
                            msg_id: reaction.data.msg_id.clone(),
                            timestamp: ts,
                            is_self,
                        };
                        if out.send(incoming).await.is_err() {
                            break;
                        }
                    }
                }
                ListenerEvent::Undo(undo) => {
                    let thread_id = undo.thread_id.clone();
                    let msg_id = undo.data.msg_id.clone();
                    let cli_msg_id = undo.data.cli_msg_id.clone();
                    let uid_from = undo.data.uid_from.clone();
                    let d_name = non_empty(&undo.data.d_name);
                    let ts = undo.data.ts.clone();
                    let is_self = undo.is_self;
                    let is_group = undo.is_group;

                    let incoming = IncomingMessage {
                        account_id: account_id.clone(),
                        thread_id: thread_id.clone(),
                        thread_kind: if is_group {
                            ThreadKind::Group
                        } else {
                            ThreadKind::User
                        },
                        from_id: uid_from,
                        from_name: d_name,
                        text: None,
                        sticker: None,
                        reaction: None,
                        quote: None,
                        link: None,
                        undo: Some(UndoEvent {
                            thread_id,
                            msg_id,
                            cli_msg_id,
                            is_self,
                            is_group,
                        }),
                        msg_id: undo.data.msg_id,
                        timestamp: ts,
                        is_self,
                    };
                    if out.send(incoming).await.is_err() {
                        break;
                    }
                }
                _ => {} // Other events (typing, seen, etc.) ignored for now
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
    send_text_with_quote(api, thread_id, text, None, ThreadKind::User).await
}

/// Send a plain-text message with an optional quote (reply). Returns the new
/// message id.
///
/// When `quote` is provided, the message is sent as a quoted reply — the
/// receiver sees the quoted message bubble above the reply text.
pub async fn send_text_with_quote(
    api: &API,
    thread_id: &str,
    text: &str,
    quote: Option<&QuoteInput>,
    kind: ThreadKind,
) -> ZaloResult<String> {
    let zca_quote = quote.map(|q| zca_rust::apis::send_message::SendMessageQuote {
        content: serde_json::Value::String(q.content.clone()),
        msg_type: q.msg_type.clone(),
        property_ext: None,
        uid_from: q.uid_from.clone(),
        msg_id: q.msg_id.clone(),
        cli_msg_id: q.cli_msg_id.clone(),
        ts: q.ts,
        ttl: q.ttl,
    });
    let content = SendContent {
        msg: text.to_string(),
        styles: None,
        urgency: None,
        quote: zca_quote,
        mentions: None,
        ttl: None,
    };
    let thread_type = match kind {
        ThreadKind::Group => ThreadType::Group,
        ThreadKind::User => ThreadType::User,
    };
    let resp = api.send_message(&content, thread_id, thread_type).await?;
    Ok(resp.message.map(|m| m.msg_id).unwrap_or_default())
}

/// Send a sticker to a thread and return the new message id.
///
/// Thin wrapper over `zca-rust` `send_sticker`; the `command`/`session` layers
/// map the core thread-kind DTO to `ThreadType` before calling this. The three
/// ids come from a [`Sticker`] the UI picked (search results) or re-sent.
pub async fn send_sticker(
    api: &API,
    thread_id: &str,
    sticker: &Sticker,
    kind: ThreadKind,
) -> ZaloResult<String> {
    let payload = SendStickerPayload {
        id: sticker.id,
        cate_id: sticker.cat_id,
        sticker_type: sticker.sticker_type,
    };
    let thread_type = match kind {
        ThreadKind::Group => ThreadType::Group,
        ThreadKind::User => ThreadType::User,
    };
    let resp = api.send_sticker(&payload, thread_id, thread_type).await?;
    Ok(resp.msg_id)
}

/// Search stickers by keyword and map them into core [`Sticker`] DTOs (each
/// with a renderable image URL), for the composer's sticker picker.
///
/// Uses `zca-rust`'s `search_sticker` (one request) and confines `zca-rust`'s
/// `StickerBasic` to this layer. `limit` caps the grid size.
pub async fn search_stickers(api: &API, keyword: &str, limit: u32) -> ZaloResult<Vec<Sticker>> {
    let results = api.search_sticker(keyword, limit).await?;
    Ok(results.into_iter().map(to_sticker).collect())
}

/// Map a `zca-rust` `StickerBasic` (search result) into a core [`Sticker`].
fn to_sticker(basic: zca_rust::models::StickerBasic) -> Sticker {
    Sticker {
        id: basic.sticker_id,
        cat_id: basic.cate_id,
        sticker_type: basic.type_,
        url: sticker_image_url(basic.sticker_id),
    }
}

/// Load all stickers in a category (a "pack") and map them into core
/// [`Sticker`] DTOs, for the picker's per-pack tab.
///
/// Uses `zca-rust`'s `get_sticker_category_detail` (confines `StickerDetail` to
/// this layer). Zalo exposes no "owned packs" listing, so the picker derives
/// the set of pack ids from recently-used stickers and loads each here.
pub async fn sticker_category(api: &API, cat_id: i64) -> ZaloResult<Vec<Sticker>> {
    let details = api.get_sticker_category_detail(cat_id).await?;
    Ok(details.into_iter().map(to_sticker_detail).collect())
}

/// Map a `zca-rust` `StickerDetail` (pack/detail result) into a core
/// [`Sticker`]. Prefers the server-provided webp render URL when present,
/// otherwise falls back to the emoticon CDN URL built from the id.
fn to_sticker_detail(detail: zca_rust::models::StickerDetail) -> Sticker {
    let url = detail
        .sticker_webp_url
        .filter(|u| !u.is_empty())
        .or_else(|| Some(detail.sticker_url.clone()).filter(|u| !u.is_empty()))
        .unwrap_or_else(|| sticker_image_url(detail.id));
    Sticker {
        id: detail.id,
        cat_id: detail.cate_id,
        sticker_type: detail.type_,
        url,
    }
}

/// Map a `zca-rust` `Reactions` enum directly to a core [`ReactionIcon`].
///
/// Confined to the `zalo` layer so `types` stays free of `zca-rust`. The
/// listener already deserializes `r_icon` into the typed enum, so no string
/// parsing is needed.
fn icon_from_zalo(r: &Reactions) -> Option<ReactionIcon> {
    match r {
        Reactions::Heart => Some(ReactionIcon::Heart),
        Reactions::Like => Some(ReactionIcon::Like),
        Reactions::Haha => Some(ReactionIcon::Haha),
        Reactions::Wow => Some(ReactionIcon::Wow),
        Reactions::Cry => Some(ReactionIcon::Cry),
        Reactions::Angry => Some(ReactionIcon::Angry),
        Reactions::Kiss => Some(ReactionIcon::Kiss),
        Reactions::TearsOfJoy => Some(ReactionIcon::TearsOfJoy),
        Reactions::Shit => Some(ReactionIcon::Shit),
        Reactions::Rose => Some(ReactionIcon::Rose),
        Reactions::BrokenHeart => Some(ReactionIcon::BrokenHeart),
        Reactions::Dislike => Some(ReactionIcon::Dislike),
        Reactions::Love => Some(ReactionIcon::Love),
        Reactions::Confused => Some(ReactionIcon::Confused),
        Reactions::Wink => Some(ReactionIcon::Wink),
        Reactions::Fade => Some(ReactionIcon::Fade),
        Reactions::Sun => Some(ReactionIcon::Sun),
        Reactions::Birthday => Some(ReactionIcon::Birthday),
        Reactions::Bomb => Some(ReactionIcon::Bomb),
        Reactions::Ok => Some(ReactionIcon::Ok),
        Reactions::Peace => Some(ReactionIcon::Peace),
        Reactions::Thanks => Some(ReactionIcon::Thanks),
        Reactions::Punch => Some(ReactionIcon::Punch),
        _ => None,
    }
}

/// Send a reaction to a message. Mirrors zca-rust's `add_reaction`.
///
/// The core `ReactionIcon` is mapped to `zca-rust`'s `ReactionIcon`/`Reactions`
/// enum; `thread_kind` maps to `ThreadType`. Confined to the `zalo` layer.
pub async fn send_reaction(
    api: &API,
    icon: ReactionIcon,
    msg_id: &str,
    cli_msg_id: &str,
    thread_id: &str,
    kind: ThreadKind,
) -> ZaloResult<()> {
    use zca_rust::apis::add_reaction::{AddReactionDestination, ReactionIcon as ZcaReactionIcon};
    let zca_icon = match icon {
        ReactionIcon::Heart => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Heart),
        ReactionIcon::Like => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Like),
        ReactionIcon::Haha => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Haha),
        ReactionIcon::Wow => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Wow),
        ReactionIcon::Cry => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Cry),
        ReactionIcon::Angry => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Angry),
        ReactionIcon::Kiss => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Kiss),
        ReactionIcon::TearsOfJoy => {
            ZcaReactionIcon::Standard(zca_rust::models::Reactions::TearsOfJoy)
        }
        ReactionIcon::Shit => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Shit),
        ReactionIcon::Rose => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Rose),
        ReactionIcon::BrokenHeart => {
            ZcaReactionIcon::Standard(zca_rust::models::Reactions::BrokenHeart)
        }
        ReactionIcon::Dislike => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Dislike),
        ReactionIcon::Love => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Love),
        ReactionIcon::Confused => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Confused),
        ReactionIcon::Wink => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Wink),
        ReactionIcon::Fade => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Fade),
        ReactionIcon::Sun => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Sun),
        ReactionIcon::Birthday => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Birthday),
        ReactionIcon::Bomb => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Bomb),
        ReactionIcon::Ok => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Ok),
        ReactionIcon::Peace => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Peace),
        ReactionIcon::Thanks => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Thanks),
        ReactionIcon::Punch => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Punch),
    };
    let thread_type = match kind {
        ThreadKind::Group => zca_rust::models::ThreadType::Group,
        ThreadKind::User => zca_rust::models::ThreadType::User,
    };
    let dest = AddReactionDestination {
        msg_id: msg_id.to_string(),
        cli_msg_id: cli_msg_id.to_string(),
        thread_id: thread_id.to_string(),
        thread_type,
    };
    api.add_reaction(zca_icon, &dest).await?;
    Ok(())
}

/// Fetch the account's friends and map them into core [`Contact`] DTOs.
///
/// Confined to the `zalo` layer so higher layers never see `zca-rust`'s `User`.
/// Returns contacts sorted by display name (case-insensitive).
pub async fn list_contacts(api: &API) -> ZaloResult<Vec<Contact>> {
    use zca_rust::models::AvatarSize;
    // Upstream default page size; one page covers a normal address book.
    let users = api.get_all_friends(20000, 1, AvatarSize::Small).await?;
    let mut contacts: Vec<Contact> = users
        .into_iter()
        .map(|u| Contact {
            user_id: u.user_id,
            display_name: if u.display_name.trim().is_empty() {
                u.zalo_name.clone()
            } else {
                u.display_name.clone()
            },
            zalo_name: non_empty(&u.zalo_name),
            avatar: non_empty(&u.avatar),
        })
        .collect();
    contacts.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    Ok(contacts)
}

/// Fetch the account's groups and map them into core [`Group`] DTOs (id + name
/// + avatar), used to resolve a group thread's display name/avatar.
///
/// Two-step like the upstream client: `get_all_groups` lists the group ids,
/// then `get_group_info` returns each group's details. Confined to the `zalo`
/// layer so higher layers never see `zca-rust`'s `GroupInfo`.
pub async fn list_groups(api: &API) -> ZaloResult<Vec<Group>> {
    let all = api.get_all_groups().await?;
    let ids: Vec<String> = all.grid_ver_map.into_keys().collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let info = api.get_group_info(&ids).await?;
    let mut groups: Vec<Group> = info
        .grid_info_map
        .into_iter()
        .filter_map(|(group_id, value)| {
            // Each value is a GroupInfo-shaped JSON object; pull name + avatar.
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let avatar = value
                .get("fullAvt")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| value.get("avt").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            if name.is_empty() {
                None
            } else {
                Some(Group {
                    group_id,
                    name,
                    avatar,
                })
            }
        })
        .collect();
    groups.sort_by_key(|group| group.name.to_lowercase());
    Ok(groups)
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
            Err(err) => assert!(
                matches!(err, ZaloError::Api { .. }),
                "expected API error, got {err}"
            ),
        }
    }

    /// Same guard for the profile path.
    #[tokio::test]
    async fn login_profile_rejects_empty_credentials() {
        let err = login_profile(blank_credentials())
            .await
            .expect_err("empty creds must error");
        assert!(
            matches!(err, ZaloError::Api { .. }),
            "expected API error, got {err}"
        );
    }

    /// The QR display mapping forwards the renderable image, the scanned
    /// account's public name/avatar, and coarse stages — and never forwards the
    /// token-bearing `GotLoginInfo` event to the UI.
    #[test]
    fn map_qr_event_forwards_only_non_secret_stages() {
        let generated = map_qr_event(&LoginQREvent::QRCodeGenerated {
            code: "secret-code".to_string(),
            image: "BASE64PNG".to_string(),
            token: "secret-token".to_string(),
        });
        assert_eq!(
            generated,
            Some(QrLoginEvent::Generated {
                image: "BASE64PNG".to_string(),
                expires_in_secs: QR_VALIDITY_SECS,
            })
        );

        let scanned = map_qr_event(&LoginQREvent::QRCodeScanned {
            avatar: "https://avatar".to_string(),
            display_name: "Tuấn".to_string(),
        });
        assert_eq!(
            scanned,
            Some(QrLoginEvent::Scanned {
                display_name: "Tuấn".to_string(),
                avatar: "https://avatar".to_string(),
            })
        );

        assert_eq!(
            map_qr_event(&LoginQREvent::QRCodeDeclined {
                code: "c".to_string()
            }),
            Some(QrLoginEvent::Declined)
        );
        assert_eq!(
            map_qr_event(&LoginQREvent::QRCodeExpired),
            Some(QrLoginEvent::Expired)
        );

        // Token-bearing event must be dropped, never surfaced to the UI.
        let leaked = map_qr_event(&LoginQREvent::GotLoginInfo {
            cookies: Vec::new(),
            imei: "device-imei".to_string(),
            user_agent: "ua".to_string(),
        });
        assert_eq!(leaked, None, "GotLoginInfo must not be forwarded to the UI");
    }

    /// The generated device imei follows the upstream shape
    /// (`<uuid>-<md5(user_agent)>`): a v4 UUID, a hyphen, then a 32-hex digest.
    /// It must also be stable across the same flow (stored for re-login).
    #[test]
    fn generated_imei_has_expected_shape() {
        let imei = generate_zalo_uuid(DEFAULT_QR_USER_AGENT);
        // uuid (36 chars: 8-4-4-4-12) + '-' + md5 hex (32 chars)
        assert_eq!(
            imei.len(),
            36 + 1 + 32,
            "imei = uuid + '-' + md5 hex, got: {imei}"
        );
        let md5_part = &imei[imei.len() - 32..];
        assert!(
            md5_part.chars().all(|c| c.is_ascii_hexdigit()),
            "trailing md5 segment must be hex, got: {md5_part}"
        );
    }

    /// Cookies read back out of an empty jar yield an empty set, and
    /// `credentials_from_qr` rejects a session with no cookies rather than
    /// producing an invalid credential.
    #[test]
    fn credentials_from_qr_requires_cookies() {
        let result = LoginQRResult {
            user_info: zca_rust::apis::login_qr::LoginUserInfo {
                name: "Tuấn".to_string(),
                avatar: String::new(),
            },
            cookie_jar: Arc::new(Jar::default()),
        };
        match credentials_from_qr(&result, DEFAULT_QR_USER_AGENT) {
            Ok(_) => panic!("empty cookie jar must not produce credentials"),
            Err(err) => assert!(
                matches!(err, ZaloError::Api { .. }),
                "expected API error for empty jar, got {err}"
            ),
        }
    }

    /// An incoming `chat.sticker` message yields a Sticker with the right ids
    /// and a renderable CDN URL; a plain `webchat` message yields no sticker.
    /// Numeric ids are accepted whether they arrive as JSON numbers or strings.
    #[test]
    fn sticker_from_content_maps_chat_sticker_only() {
        // Non-sticker content is never treated as a sticker.
        let text = ZcaMessageContent::Text("hello".to_string());
        assert_eq!(sticker_from_content("webchat", &text), None);
        // A chat.sticker msgType but text content (no ids) -> None, not a panic.
        assert_eq!(sticker_from_content("chat.sticker", &text), None);

        // A realistic sticker content object (numbers).
        let content: ZcaMessageContent =
            serde_json::from_value(serde_json::json!({ "id": 6699, "catId": 16, "type": 7 }))
                .expect("sticker content parses");
        let sticker = sticker_from_content("chat.sticker", &content).expect("maps to sticker");
        assert_eq!(sticker.id, 6699);
        assert_eq!(sticker.cat_id, 16);
        assert_eq!(sticker.sticker_type, 7);
        assert!(
            sticker.url.contains("eid=6699"),
            "url renders the sticker id: {}",
            sticker.url
        );
        assert!(
            sticker.url.starts_with("https://zalo-api.zadn.vn/"),
            "url uses the allowlisted CDN"
        );

        // Real Zalo sticker payloads carry numeric id/catId/type, so the
        // untagged zca-rust `MessageContent` routes them to `Other(Value)` and
        // the ids are preserved (the case asserted above). The `as_i64` helper
        // additionally tolerates stringized ids defensively.
    }

    /// The sticker CDN URL is well-formed and points at the allowlisted host.
    #[test]
    fn sticker_image_url_shape() {
        let url = sticker_image_url(123);
        assert_eq!(
            url,
            "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=123&size=130"
        );
    }

    /// Search results map into core Sticker DTOs with a render URL per id.
    #[test]
    fn to_sticker_maps_basic() {
        let basic = zca_rust::models::StickerBasic {
            type_: 7,
            cate_id: 16,
            sticker_id: 555,
        };
        let s = to_sticker(basic);
        assert_eq!((s.id, s.cat_id, s.sticker_type), (555, 16, 7));
        assert!(s.url.contains("eid=555"));
    }

    /// Pack/detail results prefer the server webp url, then stickerUrl, else the
    /// CDN fallback built from the id.
    #[test]
    fn to_sticker_detail_prefers_webp_then_falls_back() {
        use zca_rust::models::StickerDetail;
        // webp present -> used as-is.
        let d = StickerDetail {
            id: 42,
            cate_id: 7,
            type_: 7,
            sticker_webp_url: Some("https://cdn/webp/42.webp".to_string()),
            sticker_url: "https://cdn/png/42.png".to_string(),
            ..Default::default()
        };
        let s = to_sticker_detail(d);
        assert_eq!(s.url, "https://cdn/webp/42.webp");
        assert_eq!((s.id, s.cat_id, s.sticker_type), (42, 7, 7));

        // No webp, has stickerUrl -> stickerUrl.
        let d2 = StickerDetail {
            id: 9,
            sticker_url: "https://cdn/png/9.png".to_string(),
            ..Default::default()
        };
        assert_eq!(to_sticker_detail(d2).url, "https://cdn/png/9.png");

        // Neither -> CDN fallback by id.
        let d3 = StickerDetail {
            id: 123,
            ..Default::default()
        };
        assert!(to_sticker_detail(d3).url.contains("eid=123"));
    }

    /// Cookies set on a Zalo host are read back into core DTOs with a non-empty
    /// name/value and a Zalo domain, de-duplicated by name across hosts.
    #[test]
    fn cookies_from_jar_reads_zalo_host_cookies() {
        let jar = Arc::new(Jar::default());
        let url = "https://chat.zalo.me/".parse::<reqwest::Url>().unwrap();
        jar.add_cookie_str("zpsid=abc123; Domain=chat.zalo.me; Path=/", &url);
        jar.add_cookie_str("zpw_sek=def456; Domain=chat.zalo.me; Path=/", &url);

        let cookies = cookies_from_jar(&jar);
        assert!(cookies
            .iter()
            .any(|c| c.name == "zpsid" && c.value == "abc123"));
        assert!(cookies
            .iter()
            .any(|c| c.name == "zpw_sek" && c.value == "def456"));
        assert!(
            cookies
                .iter()
                .all(|c| c.domain.contains("zalo.me") && !c.value.is_empty()),
            "every cookie must carry a zalo.me domain and a value"
        );
    }

    /// Live QR login. Ignored by default: it opens a REAL QR login that must be
    /// scanned + confirmed on a phone within the timeout, then asserts a usable
    /// credential triple comes back (proven by logging in with it and reading a
    /// non-empty account id). Prints only non-secret diagnostics. Run with:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored qr_login_live --nocapture
    #[tokio::test]
    #[ignore = "interactive: requires scanning a real QR on a phone"]
    async fn qr_login_live() {
        let (tx, mut rx) = mpsc::channel::<QrLoginEvent>(16);
        let printer = tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    QrLoginEvent::Generated {
                        image,
                        expires_in_secs,
                    } => {
                        println!(
                            "qr_login_live: QR generated (base64 png len={}, expires_in={}s)",
                            image.len(),
                            expires_in_secs
                        );
                    }
                    QrLoginEvent::Scanned { display_name, .. } => {
                        println!("qr_login_live: scanned by '{display_name}' — confirm on phone");
                    }
                    QrLoginEvent::Declined => println!("qr_login_live: declined on phone"),
                    QrLoginEvent::Expired => println!("qr_login_live: QR expired"),
                    QrLoginEvent::Success => println!("qr_login_live: login confirmed"),
                }
            }
        });

        let credentials = run_qr_login(tx).await.expect("QR login flow failed");
        credentials
            .validate()
            .expect("QR credentials must be valid");
        let _ = printer.await;

        // Prove the issued triple is a usable session.
        let profile = login_profile(credentials)
            .await
            .expect("login with QR credentials failed");
        assert!(
            !profile.account_id.is_empty(),
            "account_id must be non-empty after QR login"
        );
        println!(
            "qr_login_live OK: uid_len={} has_display_name={}",
            profile.account_id.len(),
            profile.display_name.is_some()
        );
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
        credentials
            .validate()
            .expect(".zalo-cred.json is missing required fields");

        let profile = login_profile(credentials).await.expect("live login failed");

        assert!(
            !profile.account_id.is_empty(),
            "account_id must be non-empty after login"
        );
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
        credentials
            .validate()
            .expect(".zalo-cred.json is missing required fields");

        // self_listen so our own outgoing message is surfaced by the listener.
        let api = Arc::new(
            login_with(credentials, true)
                .await
                .expect("live login failed"),
        );
        let own_id = api.get_own_id().to_string();

        // Resolve the operator-provided test recipient by phone. self_listen
        // means our own outbound message comes back as a real inbound websocket
        // event we can match on.
        let recipient_phone = live_test_phone();
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
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        send_text(&api, &thread_id, &marker)
            .await
            .expect("send marker failed");

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
        assert!(
            !msg.msg_id.is_empty(),
            "captured message must have a msg_id"
        );
        assert_eq!(msg.account_id, own_id, "event tagged with wrong account");
        println!(
            "listener_receives_live OK: matched marker, thread_kind={:?} msg_id_len={} is_self={}",
            msg.thread_kind,
            msg.msg_id.len(),
            msg.is_self
        );
    }

    /// Live send-text smoke. Ignored by default. Logs in and sends ONE real text
    /// message to the operator-provided test recipient (resolved by phone),
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
        credentials
            .validate()
            .expect(".zalo-cred.json is missing required fields");

        let api = login(credentials).await.expect("live login failed");

        let recipient_phone = live_test_phone();
        let thread_id = find_user_uid(&api, &recipient_phone)
            .await
            .expect("could not resolve recipient by phone");

        let marker = format!(
            "zca-desktop send-text test {}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let msg_id = send_text(&api, &thread_id, &marker)
            .await
            .expect("send_text failed");

        assert!(!msg_id.is_empty(), "send_text must return a message id");
        println!("send_text_live OK: delivered, msg_id_len={}", msg_id.len());
    }

    /// Live send-sticker smoke. Ignored by default. Logs in, searches for a
    /// sticker, and sends ONE real sticker to the operator-provided test
    /// recipient (resolved by phone), asserting search returns results and Zalo
    /// returns a non-empty message id. Run explicitly:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored send_sticker_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; sends ONE real sticker to the authorized recipient"]
    async fn send_sticker_live() {
        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials
            .validate()
            .expect(".zalo-cred.json is missing required fields");

        let api = login(credentials).await.expect("live login failed");

        // Pull a real sticker from search (one request, maps to core DTOs).
        let stickers = search_stickers(&api, "hi", 24)
            .await
            .expect("search_stickers failed");
        assert!(!stickers.is_empty(), "search returned no stickers");
        assert!(
            stickers.iter().all(|s| s.id != 0 && s.url.contains("eid=")),
            "every sticker must have an id and a render url"
        );
        let picked = &stickers[0];

        let recipient_phone = live_test_phone();
        let thread_id = find_user_uid(&api, &recipient_phone)
            .await
            .expect("could not resolve recipient by phone");

        let msg_id = send_sticker(&api, &thread_id, picked, ThreadKind::User)
            .await
            .expect("send_sticker failed");
        assert!(!msg_id.is_empty(), "send_sticker must return a message id");
        // Non-secret diagnostics only: counts + lengths, never recipient/token.
        println!(
            "send_sticker_live OK: {} stickers found, delivered sticker (sticker_id_present={}, msg_id_len={})",
            stickers.len(),
            picked.id != 0,
            msg_id.len()
        );
    }

    /// Live: list_contacts loads the real friend list. Ignored by default.
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored list_contacts_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; reads the live friend list"]
    async fn list_contacts_live() {
        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials
            .validate()
            .expect(".zalo-cred.json is missing required fields");

        let api = login(credentials).await.expect("live login failed");
        let contacts = list_contacts(&api).await.expect("list_contacts failed");

        // Non-secret diagnostics only: count + whether entries are well-formed.
        assert!(
            contacts
                .iter()
                .all(|c| !c.user_id.is_empty() && !c.display_name.is_empty()),
            "every contact must have a uid and a display name"
        );
        println!(
            "list_contacts_live OK: {} contact(s) loaded",
            contacts.len()
        );
    }

    /// Live send-reaction smoke. Ignored by default. Logs in, sends a message,
    /// and then reacts to that message with a Heart. Run explicitly:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored reaction_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; sends ONE real message and reacts to it"]
    async fn reaction_live() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials
            .validate()
            .expect(".zalo-cred.json is missing required fields");

        let api = login(credentials).await.expect("live login failed");

        let recipient_phone = live_test_phone();
        let thread_id = find_user_uid(&api, &recipient_phone)
            .await
            .expect("could not resolve recipient by phone");

        let marker = format!(
            "zca-desktop reaction test {}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
        );
        let msg_id = send_text(&api, &thread_id, &marker)
            .await
            .expect("send_text failed");
        assert!(!msg_id.is_empty(), "send_text must return a message id");

        let cli_msg_id = format!("{}_cli", msg_id);
        send_reaction(
            &api,
            ReactionIcon::Heart,
            &msg_id,
            &cli_msg_id,
            &thread_id,
            ThreadKind::User,
        )
        .await
        .expect("send_reaction failed");
        println!("reaction_live OK: reacted Heart to msg_id={}", msg_id);
    }

    fn live_test_phone() -> String {
        std::env::var("ZALO_TEST_PHONE")
            .expect("set ZALO_TEST_PHONE to an authorized test recipient phone number")
    }
}
