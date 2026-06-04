use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RealtimeEvent {
    pub user_id: Uuid,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub service: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicLinkRequest {
    pub email: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicLinkResponse {
    pub sent: bool,
    pub expires_in_secs: u64,
    pub dev_magic_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicLinkVerifyRequest {
    pub email: String,
    pub token: String,
    pub device_name: String,
    #[serde(default)]
    pub recovery_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicLinkVerifyResponse {
    pub user_id: Uuid,
    pub device_id: Uuid,
    pub device_token: String,
    pub recovery_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegisterRequest {
    pub name: String,
    pub recovery_key: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: Uuid,
    pub name: String,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegisterResponse {
    pub device_id: Uuid,
    pub device_token: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: Uuid,
    pub zalo_account_id: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrStartResponse {
    pub flow_id: Uuid,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrFlowStatus {
    #[serde(skip_serializing)]
    pub user_id: Uuid,
    pub flow_id: Uuid,
    pub state: String,
    #[serde(default)]
    pub qr_image: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub account_id: Option<Uuid>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTextRequest {
    pub thread_id: String,
    pub text: String,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendTextResponse {
    pub queued: bool,
    pub msg_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendStickerRequest {
    pub thread_id: String,
    pub sticker_id: i64,
    pub cat_id: i64,
    pub sticker_type: i64,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReactionRequest {
    pub thread_id: String,
    pub msg_id: String,
    pub cli_msg_id: String,
    pub icon: String,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFileRequest {
    pub thread_id: String,
    pub file_id: Uuid,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFileResponse {
    pub queued: bool,
    pub msg_id: Option<String>,
    pub reason: Option<String>,
    pub file: RichFile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePhoneRequest {
    pub phone: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePhoneResponse {
    pub uid: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub id: Uuid,
    pub account_id: Uuid,
    pub thread_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub avatar: Option<String>,
    pub last_at: Option<DateTime<Utc>>,
    pub unread: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub msg_id: String,
    pub from_id: Option<String>,
    pub from_name: Option<String>,
    pub from_avatar: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    pub outgoing: bool,
    pub kind: String,
    pub observed_at: DateTime<Utc>,
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker: Option<RichSticker>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<RichQuote>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<RichLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<RichFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reaction_icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RichSticker {
    pub id: i64,
    pub cat_id: i64,
    pub sticker_type: i64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RichQuote {
    pub owner_id: String,
    pub from_d: String,
    pub global_msg_id: i64,
    pub cli_msg_id: i64,
    pub msg: String,
    pub cli_msg_type: i64,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RichLink {
    pub href: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RichFile {
    pub id: Option<String>,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: i64,
    pub href: Option<String>,
    pub thumb: Option<String>,
    pub media_kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageRichPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticker: Option<RichSticker>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<RichQuote>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<RichLink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<RichFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reaction_icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
}

impl MessageRichPayload {
    pub fn is_empty(&self) -> bool {
        self.sticker.is_none()
            && self.quote.is_none()
            && self.link.is_none()
            && self.file.is_none()
            && self.reaction_icon.is_none()
            && self.raw.is_none()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInitRequest {
    pub account_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub message_id: Option<Uuid>,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: i64,
    pub content_sha256: String,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub id: Uuid,
    pub object_key: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: i64,
    pub content_sha256: String,
    pub created_at: DateTime<Utc>,
}
