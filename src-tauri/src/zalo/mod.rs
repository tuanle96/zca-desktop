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
use zca_rust::crypto::generate_zalo_uuid;
use zca_rust::listen::ListenerEvent;
use zca_rust::models::{Message, MessageContent as ZcaMessageContent, ThreadType};
use zca_rust::zalo::{Cookie as ZcaCookie, Credentials as ZcaCredentials};
use zca_rust::context::Options;
use zca_rust::Zalo;

use crate::types::{
    AccountProfile, Contact, Cookie, Credentials, IncomingMessage, QrLoginEvent, ThreadKind,
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
        LoginQREvent::QRCodeGenerated { image, .. } => {
            Some(QrLoginEvent::Generated {
                image: image.clone(),
                expires_in_secs: QR_VALIDITY_SECS,
            })
        }
        LoginQREvent::QRCodeScanned { avatar, display_name } => Some(QrLoginEvent::Scanned {
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
    credentials.validate().map_err(|e| ZaloError::api(e.to_string()))?;
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
        let Some(header) = jar.cookies(&url) else { continue };
        let Ok(header_str) = header.to_str() else { continue };
        for pair in header_str.split(';') {
            let pair = pair.trim();
            let Some((name, value)) = pair.split_once('=') else { continue };
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
    (non_empty(&info.profile.display_name), non_empty(&info.profile.avatar))
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
    contacts.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(contacts)
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
            map_qr_event(&LoginQREvent::QRCodeDeclined { code: "c".to_string() }),
            Some(QrLoginEvent::Declined)
        );
        assert_eq!(map_qr_event(&LoginQREvent::QRCodeExpired), Some(QrLoginEvent::Expired));

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
        assert_eq!(imei.len(), 36 + 1 + 32, "imei = uuid + '-' + md5 hex, got: {imei}");
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

    /// Cookies set on a Zalo host are read back into core DTOs with a non-empty
    /// name/value and a Zalo domain, de-duplicated by name across hosts.
    #[test]
    fn cookies_from_jar_reads_zalo_host_cookies() {
        let jar = Arc::new(Jar::default());
        let url = "https://chat.zalo.me/".parse::<reqwest::Url>().unwrap();
        jar.add_cookie_str("zpsid=abc123; Domain=chat.zalo.me; Path=/", &url);
        jar.add_cookie_str("zpw_sek=def456; Domain=chat.zalo.me; Path=/", &url);

        let cookies = cookies_from_jar(&jar);
        assert!(cookies.iter().any(|c| c.name == "zpsid" && c.value == "abc123"));
        assert!(cookies.iter().any(|c| c.name == "zpw_sek" && c.value == "def456"));
        assert!(
            cookies.iter().all(|c| c.domain.contains("zalo.me") && !c.value.is_empty()),
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
                    QrLoginEvent::Generated { image, expires_in_secs } => {
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
        credentials.validate().expect("QR credentials must be valid");
        let _ = printer.await;

        // Prove the issued triple is a usable session.
        let profile = login_profile(credentials).await.expect("login with QR credentials failed");
        assert!(!profile.account_id.is_empty(), "account_id must be non-empty after QR login");
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

    /// Live: list_contacts loads the real friend list. Ignored by default.
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored list_contacts_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; reads the live friend list"]
    async fn list_contacts_live() {
        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials.validate().expect(".zalo-cred.json is missing required fields");

        let api = login(credentials).await.expect("live login failed");
        let contacts = list_contacts(&api).await.expect("list_contacts failed");

        // Non-secret diagnostics only: count + whether entries are well-formed.
        assert!(
            contacts.iter().all(|c| !c.user_id.is_empty() && !c.display_name.is_empty()),
            "every contact must have a uid and a display name"
        );
        println!("list_contacts_live OK: {} contact(s) loaded", contacts.len());
    }
}
