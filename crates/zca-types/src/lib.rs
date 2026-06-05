//! Single Rust source of truth for the cloud **wire** contract.
//!
//! These were hand-duplicated across `server/models.rs`, the desktop's
//! `command/cloud.rs`, and the TS frontend. Now they live here once:
//! - the server depends on this crate with the **`sqlx`** feature and re-exports
//!   these types (so `FromRow` still works, mapping Postgres rows);
//! - `cargo test -p zca-types --features ts` regenerates the matching TypeScript
//!   at `packages/types/src/generated/contract.ts`.
//!
//! Feature gating keeps `ts-rs` out of normal builds and keeps `sqlx` (whose
//! `sqlx-sqlite` links the `sqlite3` native lib) OUT of the clients workspace,
//! where it would collide with the desktop's `rusqlite`.
//!
//! Field encoding is camelCase on both sides. `Uuid`/`DateTime<Utc>` serialize as
//! strings on the wire and are emitted as `string` in TS.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

// A small helper to cut down on repetition would obscure the per-type derives, so
// each struct spells out its serde + (optional) ts_rs/sqlx derives explicitly.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct MagicLinkRequest {
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct MagicLinkResponse {
    pub sent: bool,
    // u64 → JS `number` (the value arrives as a JSON number, not a bigint).
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub expires_in_secs: u64,
    pub dev_magic_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct MagicLinkVerifyRequest {
    pub email: String,
    pub token: String,
    pub device_name: String,
    #[serde(default)]
    pub recovery_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct MagicLinkVerifyResponse {
    pub user_id: Uuid,
    pub device_id: Uuid,
    pub device_token: String,
    pub recovery_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct DeviceRegisterRequest {
    pub name: String,
    pub recovery_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "sqlx", derive(sqlx::FromRow))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct DeviceView {
    pub id: Uuid,
    pub name: String,
    pub revoked_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct DeviceRegisterResponse {
    pub device_id: Uuid,
    pub device_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "sqlx", derive(sqlx::FromRow))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct AccountView {
    pub id: Uuid,
    pub zalo_account_id: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct QrStartResponse {
    pub flow_id: Uuid,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct QrFlowStatus {
    // Internal correlation id — never serialized to clients.
    #[serde(skip_serializing)]
    #[cfg_attr(feature = "ts", ts(skip))]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct SendTextRequest {
    pub thread_id: String,
    pub text: String,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct SendTextResponse {
    pub queued: bool,
    pub msg_id: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct SendStickerRequest {
    pub thread_id: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub sticker_id: i64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub cat_id: i64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub sticker_type: i64,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct SendReactionRequest {
    pub thread_id: String,
    pub msg_id: String,
    pub cli_msg_id: String,
    pub icon: String,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct SendFileRequest {
    pub thread_id: String,
    pub file_id: Uuid,
    #[serde(default)]
    pub thread_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct SendFileResponse {
    pub queued: bool,
    pub msg_id: Option<String>,
    pub reason: Option<String>,
    pub file: RichFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct ResolvePhoneRequest {
    pub phone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct ResolvePhoneResponse {
    pub uid: String,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
}

/// A non-secret contact (friend) entry. Carries only display data.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct ContactView {
    pub user_id: String,
    pub display_name: String,
    pub zalo_name: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "sqlx", derive(sqlx::FromRow))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "sqlx", derive(sqlx::FromRow))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
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
    #[cfg_attr(feature = "ts", ts(type = "unknown | null"))]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct RichSticker {
    // i64 ids arrive as JSON numbers and are consumed as JS `number` (ts-rs would
    // otherwise emit `bigint`). Same for the other id/size i64 fields below.
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub id: i64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub cat_id: i64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub sticker_type: i64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct RichQuote {
    pub owner_id: String,
    pub from_d: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub global_msg_id: i64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub cli_msg_id: i64,
    pub msg: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub cli_msg_type: i64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct RichLink {
    pub href: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub thumb: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct RichFile {
    pub id: Option<String>,
    pub filename: Option<String>,
    pub mime: Option<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size_bytes: i64,
    pub href: Option<String>,
    pub thumb: Option<String>,
    pub media_kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
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
    #[cfg_attr(feature = "ts", ts(type = "unknown | null"))]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct FileInitRequest {
    pub account_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub message_id: Option<Uuid>,
    pub filename: Option<String>,
    pub mime: Option<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size_bytes: i64,
    pub content_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "sqlx", derive(sqlx::FromRow))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(rename_all = "camelCase"))]
pub struct FileView {
    pub id: Uuid,
    pub object_key: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub size_bytes: i64,
    pub content_sha256: String,
    pub created_at: DateTime<Utc>,
}

#[cfg(all(test, feature = "ts"))]
mod codegen {
    use super::*;
    use ts_rs::TS;

    /// Regenerates the TS mirror of the wire contract. Run with:
    /// `cargo test -p zca-types --features ts`.
    #[test]
    fn write_ts_contract() {
        let decls = [
            MagicLinkRequest::decl(),
            MagicLinkResponse::decl(),
            MagicLinkVerifyRequest::decl(),
            MagicLinkVerifyResponse::decl(),
            DeviceRegisterRequest::decl(),
            DeviceView::decl(),
            DeviceRegisterResponse::decl(),
            AccountView::decl(),
            QrStartResponse::decl(),
            QrFlowStatus::decl(),
            SendTextRequest::decl(),
            SendTextResponse::decl(),
            SendStickerRequest::decl(),
            SendReactionRequest::decl(),
            SendFileRequest::decl(),
            SendFileResponse::decl(),
            ResolvePhoneRequest::decl(),
            ResolvePhoneResponse::decl(),
            ContactView::decl(),
            ConversationView::decl(),
            MessageView::decl(),
            RichSticker::decl(),
            RichQuote::decl(),
            RichLink::decl(),
            RichFile::decl(),
            MessageRichPayload::decl(),
            FileInitRequest::decl(),
            FileView::decl(),
        ];
        let body = decls
            .into_iter()
            .map(|d| format!("export {d}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let contents = format!(
            "// AUTO-GENERATED by `cargo test -p zca-types --features ts`. Do not edit by hand.\n\
             // Source of truth: crates/zca-types/src/lib.rs (Rust). Regenerate after changes.\n\n\
             {body}\n"
        );

        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/types/src/generated");
        std::fs::create_dir_all(dir).expect("create generated dir");
        std::fs::write(format!("{dir}/contract.ts"), contents).expect("write contract.ts");
    }
}
