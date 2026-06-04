use std::sync::Arc;

use reqwest::cookie::{CookieStore, Jar};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use zca_rust::apis::add_reaction::{AddReactionDestination, ReactionIcon as ZcaReactionIcon};
use zca_rust::apis::login_qr::{login_qr, LoginQREvent, LoginQROptions, LoginQRResult};
use zca_rust::apis::send_message::MessageContent as SendContent;
use zca_rust::apis::send_sticker::SendStickerPayload;
use zca_rust::crypto::generate_zalo_uuid;
use zca_rust::listen::{Listener, ListenerEvent};
use zca_rust::models::{Message, MessageContent as ZcaMessageContent, Reactions, ThreadType};
use zca_rust::zalo::{Cookie as ZcaCookie, Credentials as ZcaCredentials};
use zca_rust::{Result as ZaloResult, Zalo, ZaloError, API};

use crate::models::{MessageRichPayload, RichFile, RichLink, RichQuote, RichSticker};

const DEFAULT_QR_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0";
const QR_VALIDITY_SECS: u64 = 100;
const ZALO_COOKIE_HOSTS: [&str; 5] = [
    "https://zalo.me/",
    "https://chat.zalo.me/",
    "https://wpa.chat.zalo.me/",
    "https://id.zalo.me/",
    "https://jr.chat.zalo.me/",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedCookie {
    pub domain: String,
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub expiration_date: Option<f64>,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub session: bool,
    #[serde(default)]
    pub store_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedCredentials {
    pub imei: String,
    pub cookie: Vec<HostedCookie>,
    pub user_agent: String,
    #[serde(default = "default_language")]
    pub language: String,
}

#[derive(Debug, Clone)]
pub struct HostedProfile {
    pub account_id: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone)]
pub enum HostedQrEvent {
    Generated {
        image: String,
    },
    Scanned {
        display_name: String,
        avatar: String,
    },
    Declined,
    Expired,
    Success {
        profile: HostedProfile,
    },
}

#[derive(Debug, Clone)]
pub struct HostedIncomingMessage {
    pub thread_id: String,
    pub kind: &'static str,
    pub msg_id: String,
    pub from_id: Option<String>,
    pub from_name: Option<String>,
    pub text: Option<String>,
    pub rich: Option<MessageRichPayload>,
    pub outgoing: bool,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HostedReactionEvent {
    pub thread_id: String,
    pub msg_id: String,
    pub icon: String,
    pub from_id: Option<String>,
    pub from_name: Option<String>,
    pub outgoing: bool,
    pub is_group: bool,
}

#[derive(Debug, Clone)]
pub struct HostedUndoEvent {
    pub thread_id: String,
    pub msg_id: String,
    pub cli_msg_id: String,
    pub outgoing: bool,
    pub is_group: bool,
}

#[derive(Debug, Clone)]
pub enum HostedRealtimeEvent {
    Message(Box<HostedIncomingMessage>),
    Reaction(HostedReactionEvent),
    Undo(HostedUndoEvent),
}

#[derive(Debug, Clone, Default)]
pub struct HostedThreadMetadata {
    pub title: Option<String>,
    pub avatar: Option<String>,
}

fn default_language() -> String {
    "vi".to_string()
}

fn to_zca_credentials(credentials: &HostedCredentials) -> ZcaCredentials {
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

pub async fn login(credentials: HostedCredentials, self_listen: bool) -> ZaloResult<API> {
    let options = zca_rust::context::Options {
        self_listen,
        ..Default::default()
    };
    Zalo::new(Some(options))
        .login(to_zca_credentials(&credentials))
        .await
}

pub async fn run_qr_login(
    events: mpsc::Sender<HostedQrEvent>,
) -> ZaloResult<(HostedCredentials, API, HostedProfile)> {
    let user_agent = DEFAULT_QR_USER_AGENT.to_string();
    let options = LoginQROptions {
        user_agent: user_agent.clone(),
        qr_timeout: std::time::Duration::from_secs(QR_VALIDITY_SECS),
    };
    let tx = events.clone();
    let result: LoginQRResult = login_qr(options, |event| {
        if let Some(mapped) = map_qr_event(&event) {
            let _ = tx.try_send(mapped);
        }
    })
    .await?;
    let credentials = credentials_from_qr(&result, &user_agent)?;
    let api = login(credentials.clone(), true).await?;
    let profile = profile_of(&api).await;
    let _ = events.try_send(HostedQrEvent::Success {
        profile: profile.clone(),
    });
    Ok((credentials, api, profile))
}

pub async fn profile_of(api: &API) -> HostedProfile {
    let (display_name, avatar) = fetch_profile_fields(api).await;
    HostedProfile {
        account_id: api.get_own_id().to_string(),
        display_name,
        avatar,
    }
}

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

fn map_qr_event(event: &LoginQREvent) -> Option<HostedQrEvent> {
    match event {
        LoginQREvent::QRCodeGenerated { image, .. } => Some(HostedQrEvent::Generated {
            image: image.clone(),
        }),
        LoginQREvent::QRCodeScanned {
            avatar,
            display_name,
        } => Some(HostedQrEvent::Scanned {
            display_name: display_name.clone(),
            avatar: avatar.clone(),
        }),
        LoginQREvent::QRCodeDeclined { .. } => Some(HostedQrEvent::Declined),
        LoginQREvent::QRCodeExpired => Some(HostedQrEvent::Expired),
        LoginQREvent::GotLoginInfo { .. } => None,
    }
}

fn credentials_from_qr(result: &LoginQRResult, user_agent: &str) -> ZaloResult<HostedCredentials> {
    let cookie = cookies_from_jar(&result.cookie_jar);
    if cookie.is_empty() {
        return Err(ZaloError::api("QR login returned no session cookies"));
    }
    Ok(HostedCredentials {
        imei: generate_zalo_uuid(user_agent),
        cookie,
        user_agent: user_agent.to_string(),
        language: "vi".to_string(),
    })
}

fn cookies_from_jar(jar: &Arc<Jar>) -> Vec<HostedCookie> {
    let mut seen = std::collections::HashSet::new();
    let mut cookies = Vec::new();
    for host in ZALO_COOKIE_HOSTS {
        let Ok(url) = host.parse::<reqwest::Url>() else {
            continue;
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
            cookies.push(HostedCookie {
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

pub async fn start_message_listener(
    api: Arc<API>,
    out: mpsc::Sender<HostedRealtimeEvent>,
) -> ZaloResult<Listener> {
    let urls = listener_urls(&api)?;
    let (mut listener, mut rx) = Listener::new(api.ctx.clone(), urls);
    listener.start(true).await?;
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let incoming = match event {
                ListenerEvent::Message(boxed) => to_incoming_message(&boxed)
                    .map(|message| HostedRealtimeEvent::Message(Box::new(message))),
                ListenerEvent::Reaction(reaction) => {
                    Some(HostedRealtimeEvent::Reaction(to_reaction_event(&reaction)))
                }
                ListenerEvent::Undo(undo) => Some(HostedRealtimeEvent::Undo(to_undo_event(&undo))),
                _ => None,
            };
            if let Some(message) = incoming {
                if out.send(message).await.is_err() {
                    break;
                }
            }
        }
    });
    Ok(listener)
}

fn to_incoming_message(message: &Message) -> Option<HostedIncomingMessage> {
    match message {
        Message::User(m) => Some(HostedIncomingMessage {
            thread_id: m.thread_id.clone(),
            kind: "user",
            msg_id: m.data.msg_id.clone(),
            from_id: Some(m.data.uid_from.clone()),
            from_name: non_empty(&m.data.d_name),
            text: message_text(&m.data.content),
            rich: rich_from_parts(&m.data.msg_type, &m.data.content, m.data.quote.as_ref()),
            outgoing: m.is_self,
            timestamp: Some(m.data.ts.clone()),
        }),
        Message::Group(m) => Some(HostedIncomingMessage {
            thread_id: m.thread_id.clone(),
            kind: "group",
            msg_id: m.data.base.msg_id.clone(),
            from_id: Some(m.data.base.uid_from.clone()),
            from_name: non_empty(&m.data.base.d_name),
            text: message_text(&m.data.base.content),
            rich: rich_from_parts(
                &m.data.base.msg_type,
                &m.data.base.content,
                m.data.base.quote.as_ref(),
            ),
            outgoing: m.is_self,
            timestamp: Some(m.data.base.ts.clone()),
        }),
    }
}

fn sticker_image_url(sticker_id: i64) -> String {
    format!("https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid={sticker_id}&size=130")
}

fn sticker_from_content(msg_type: &str, content: &ZcaMessageContent) -> Option<RichSticker> {
    if msg_type != "chat.sticker" {
        return None;
    }
    let value = serde_json::to_value(content).ok()?;
    let as_i64 = |v: &serde_json::Value| -> Option<i64> {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    };
    let id = value.get("id").and_then(as_i64)?;
    if id == 0 {
        return None;
    }
    Some(RichSticker {
        id,
        cat_id: value.get("catId").and_then(as_i64).unwrap_or(0),
        sticker_type: value.get("type").and_then(as_i64).unwrap_or(0),
        url: sticker_image_url(id),
    })
}

fn link_from_content(msg_type: &str, content: &ZcaMessageContent) -> Option<RichLink> {
    if msg_type != "chat.link" {
        return None;
    }
    match content {
        ZcaMessageContent::Attachment(att) if !att.href.trim().is_empty() => Some(RichLink {
            href: att.href.clone(),
            title: non_empty(&att.title),
            description: non_empty(&att.description),
            thumb: non_empty(&att.thumb),
        }),
        _ => None,
    }
}

fn file_from_content(msg_type: &str, content: &ZcaMessageContent) -> Option<RichFile> {
    if msg_type == "chat.link" || msg_type == "chat.sticker" {
        return None;
    }
    match content {
        ZcaMessageContent::Attachment(att) => {
            if att.href.trim().is_empty()
                && att.title.trim().is_empty()
                && att.thumb.trim().is_empty()
            {
                return None;
            }
            Some(RichFile {
                id: None,
                filename: non_empty(&att.title),
                mime: None,
                size_bytes: 0,
                href: non_empty(&att.href),
                thumb: non_empty(&att.thumb),
                media_kind: media_kind(msg_type, att.type_.as_str()),
            })
        }
        _ => None,
    }
}

fn media_kind(msg_type: &str, attachment_type: &str) -> Option<String> {
    let raw = if !msg_type.trim().is_empty() {
        msg_type
    } else {
        attachment_type
    }
    .to_ascii_lowercase();
    if raw.contains("photo") || raw.contains("image") || raw.contains("picture") {
        Some("image".to_string())
    } else if raw.contains("video") {
        Some("video".to_string())
    } else if raw.contains("audio") || raw.contains("voice") {
        Some("audio".to_string())
    } else if raw.contains("file") || raw.contains("attach") {
        Some("file".to_string())
    } else {
        None
    }
}

fn quote_from_zca(q: &zca_rust::models::Quote) -> RichQuote {
    RichQuote {
        owner_id: q.owner_id.clone(),
        from_d: q.from_d.clone(),
        global_msg_id: q.global_msg_id,
        cli_msg_id: q.cli_msg_id,
        msg: q.msg.clone(),
        cli_msg_type: q.cli_msg_type,
        ts: q.ts,
    }
}

fn rich_from_parts(
    msg_type: &str,
    content: &ZcaMessageContent,
    quote: Option<&zca_rust::models::Quote>,
) -> Option<MessageRichPayload> {
    let rich = MessageRichPayload {
        sticker: sticker_from_content(msg_type, content),
        quote: quote.map(quote_from_zca),
        link: link_from_content(msg_type, content),
        file: file_from_content(msg_type, content),
        reaction_icon: None,
        raw: None,
    };
    (!rich.is_empty()).then_some(rich)
}

fn reaction_icon(reaction: &Reactions) -> String {
    match reaction {
        Reactions::Heart => "❤️",
        Reactions::Like => "👍",
        Reactions::Haha => "😆",
        Reactions::Wow => "😮",
        Reactions::Cry => "😢",
        Reactions::Angry => "😠",
        Reactions::Kiss => "😘",
        Reactions::TearsOfJoy => "😂",
        Reactions::Shit => "💩",
        Reactions::Rose => "🌹",
        Reactions::BrokenHeart => "💔",
        Reactions::Dislike => "👎",
        Reactions::Love => "😍",
        Reactions::Confused => "😕",
        Reactions::Wink => "😉",
        Reactions::Sun => "☀️",
        Reactions::Birthday => "🎂",
        Reactions::Bomb => "💣",
        Reactions::Ok => "👌",
        Reactions::Peace => "✌️",
        Reactions::Thanks => "🙏",
        Reactions::Punch => "👊",
        _ => "👍",
    }
    .to_string()
}

fn to_reaction_event(reaction: &zca_rust::models::Reaction) -> HostedReactionEvent {
    let msg_id = reaction
        .data
        .content
        .r_msg
        .first()
        .map(|m| m.g_msg_id.clone())
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| reaction.data.msg_id.clone());
    HostedReactionEvent {
        thread_id: reaction.thread_id.clone(),
        msg_id,
        icon: reaction_icon(&reaction.data.content.r_icon),
        from_id: Some(reaction.data.uid_from.clone()),
        from_name: reaction.data.d_name.clone().and_then(|s| non_empty(&s)),
        outgoing: reaction.is_self,
        is_group: reaction.is_group,
    }
}

fn to_undo_event(undo: &zca_rust::models::Undo) -> HostedUndoEvent {
    HostedUndoEvent {
        thread_id: undo.thread_id.clone(),
        msg_id: undo.data.content.global_msg_id.to_string(),
        cli_msg_id: undo.data.content.cli_msg_id.to_string(),
        outgoing: undo.is_self,
        is_group: undo.is_group,
    }
}

fn message_text(content: &ZcaMessageContent) -> Option<String> {
    match content {
        ZcaMessageContent::Text(s) => Some(s.clone()),
        _ => None,
    }
}

pub async fn send_text(api: &API, thread_id: &str, text: &str, kind: &str) -> ZaloResult<String> {
    let content = SendContent {
        msg: text.to_string(),
        styles: None,
        urgency: None,
        quote: None,
        mentions: None,
        ttl: None,
    };
    let thread_type = if kind == "group" {
        ThreadType::Group
    } else {
        ThreadType::User
    };
    let resp = api.send_message(&content, thread_id, thread_type).await?;
    Ok(resp.message.map(|m| m.msg_id).unwrap_or_default())
}

pub async fn resolve_phone(api: &API, phone: &str) -> ZaloResult<HostedProfile> {
    let user = api
        .find_user(phone, zca_rust::models::AvatarSize::Small)
        .await?;
    Ok(HostedProfile {
        account_id: user.uid,
        display_name: non_empty(&user.display_name),
        avatar: non_empty(&user.avatar),
    })
}

pub async fn thread_metadata(
    api: &API,
    thread_id: &str,
    kind: &str,
) -> ZaloResult<HostedThreadMetadata> {
    if kind == "group" {
        let resp = api.get_group_info(&[thread_id.to_string()]).await?;
        let Some(value) = resp.grid_info_map.get(thread_id) else {
            return Ok(HostedThreadMetadata::default());
        };
        let group: zca_rust::models::GroupInfo =
            serde_json::from_value(value.clone()).unwrap_or_default();
        return Ok(HostedThreadMetadata {
            title: non_empty(&group.name),
            avatar: non_empty(&group.full_avt).or_else(|| non_empty(&group.avt)),
        });
    }

    let resp = zca_rust::apis::get_user_info::get_user_info(
        api.get_context(),
        &[thread_id.to_string()],
        zca_rust::models::AvatarSize::Small,
    )
    .await?;
    let profile = resp
        .changed_profiles
        .get(thread_id)
        .or_else(|| resp.changed_profiles.get(&format!("{thread_id}_0")))
        .or_else(|| resp.changed_profiles.values().next());
    Ok(HostedThreadMetadata {
        title: profile.and_then(|p| non_empty(&p.display_name)),
        avatar: profile.and_then(|p| non_empty(&p.avatar)),
    })
}

pub async fn send_sticker(
    api: &API,
    thread_id: &str,
    sticker_id: i64,
    cat_id: i64,
    sticker_type: i64,
    kind: &str,
) -> ZaloResult<String> {
    let payload = SendStickerPayload {
        id: sticker_id,
        cate_id: cat_id,
        sticker_type,
    };
    let thread_type = if kind == "group" {
        ThreadType::Group
    } else {
        ThreadType::User
    };
    let resp = api.send_sticker(&payload, thread_id, thread_type).await?;
    Ok(resp.msg_id)
}

pub async fn send_reaction(
    api: &API,
    icon: &str,
    msg_id: &str,
    cli_msg_id: &str,
    thread_id: &str,
    kind: &str,
) -> ZaloResult<()> {
    let zca_icon = match icon {
        "heart" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Heart),
        "like" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Like),
        "haha" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Haha),
        "wow" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Wow),
        "cry" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Cry),
        "angry" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Angry),
        "kiss" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Kiss),
        "tearsOfJoy" | "tears_of_joy" => {
            ZcaReactionIcon::Standard(zca_rust::models::Reactions::TearsOfJoy)
        }
        "shit" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Shit),
        "rose" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Rose),
        "brokenHeart" | "broken_heart" => {
            ZcaReactionIcon::Standard(zca_rust::models::Reactions::BrokenHeart)
        }
        "dislike" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Dislike),
        "love" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Love),
        "confused" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Confused),
        "wink" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Wink),
        "fade" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Fade),
        "sun" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Sun),
        "birthday" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Birthday),
        "bomb" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Bomb),
        "ok" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Ok),
        "peace" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Peace),
        "thanks" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Thanks),
        "punch" => ZcaReactionIcon::Standard(zca_rust::models::Reactions::Punch),
        _ => return Err(ZaloError::api("Invalid reaction")),
    };
    let thread_type = if kind == "group" {
        ThreadType::Group
    } else {
        ThreadType::User
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

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zca_rust::models::{AttachmentContent, MessageContent, Quote};

    #[test]
    fn hosted_credentials_do_not_debug_print() {
        fn assert_no_debug<T>() {}
        assert_no_debug::<HostedCredentials>();
    }

    #[test]
    fn rich_payload_maps_quote_link_file_and_sticker() {
        let quote = Quote {
            owner_id: "u1".to_string(),
            from_d: "Tuấn".to_string(),
            global_msg_id: 42,
            cli_msg_id: 24,
            msg: "quoted".to_string(),
            cli_msg_type: 1,
            ts: 123,
            ..Default::default()
        };
        let link_content = MessageContent::Attachment(AttachmentContent {
            title: "Example".to_string(),
            description: "Description".to_string(),
            href: "https://example.com".to_string(),
            thumb: "https://example.com/thumb.jpg".to_string(),
            ..Default::default()
        });
        let link = rich_from_parts("chat.link", &link_content, Some(&quote)).unwrap();
        assert_eq!(link.quote.as_ref().unwrap().msg, "quoted");
        assert_eq!(link.link.as_ref().unwrap().href, "https://example.com");
        assert!(link.file.is_none());

        let file_content = MessageContent::Attachment(AttachmentContent {
            title: "photo.jpg".to_string(),
            href: "https://zalo.example/photo.jpg".to_string(),
            thumb: "https://zalo.example/photo-thumb.jpg".to_string(),
            type_: "photo".to_string(),
            ..Default::default()
        });
        let file = rich_from_parts("chat.photo", &file_content, None).unwrap();
        assert_eq!(
            file.file.as_ref().unwrap().media_kind.as_deref(),
            Some("image")
        );
        assert_eq!(
            file.file.as_ref().unwrap().filename.as_deref(),
            Some("photo.jpg")
        );

        let sticker_content = serde_json::from_value::<MessageContent>(serde_json::json!({
            "id": "123",
            "catId": 9,
            "type": 1
        }))
        .unwrap();
        let sticker = rich_from_parts("chat.sticker", &sticker_content, None).unwrap();
        assert_eq!(sticker.sticker.as_ref().unwrap().id, 123);
        assert!(sticker.sticker.as_ref().unwrap().url.contains("eid=123"));
    }

    #[test]
    fn reaction_icons_are_ui_ready_emoji() {
        assert_eq!(reaction_icon(&Reactions::Heart), "❤️");
        assert_eq!(reaction_icon(&Reactions::Like), "👍");
        assert_eq!(reaction_icon(&Reactions::Wow), "😮");
    }
}
