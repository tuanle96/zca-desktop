//! Persisted-history DTOs surfaced to the UI (`types` layer, ADR-0003 / 0005).
//!
//! Pure data: what the `store` layer reads back from SQLite and the `command`
//! layer hands to the frontend so chat history survives restarts. No secrets.

use serde::{Deserialize, Serialize};

use crate::types::{AccountId, ThreadKind};

/// A conversation row reloaded from the local store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredThread {
    pub account_id: AccountId,
    pub thread_id: String,
    pub kind: ThreadKind,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
    /// Last activity timestamp (epoch millis), when known.
    #[serde(default)]
    pub last_at: Option<i64>,
    pub unread: i64,
}

/// A single message reloaded from the local store.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub account_id: AccountId,
    pub thread_id: String,
    pub msg_id: String,
    #[serde(default)]
    pub from_id: Option<String>,
    #[serde(default)]
    pub from_name: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    /// Sticker payload when this stored message is a sticker; `None` for text.
    #[serde(default)]
    pub sticker: Option<crate::types::Sticker>,
    /// Quoted message reference when this message is a reply.
    #[serde(default)]
    pub quote: Option<crate::types::QuoteRef>,
    /// Link preview when this message is a link payload.
    #[serde(default)]
    pub link: Option<crate::types::LinkPreview>,
    /// Last reaction emoji applied to this message, when known.
    #[serde(default)]
    pub reaction_icon: Option<String>,
    /// True when an undo/delete event has recalled this message.
    #[serde(default)]
    pub deleted: bool,
    pub outgoing: bool,
    /// Message timestamp (epoch millis), when known.
    #[serde(default)]
    pub ts: Option<i64>,
}

/// The history bundle returned to the UI for one account: threads + their
/// recent messages keyed by thread id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub threads: Vec<StoredThread>,
    pub messages: Vec<StoredMessage>,
}

/// Conversation identity (title + avatar) resolved from directory data
/// (contacts/groups), used to backfill persisted thread rows.
///
/// The realtime message stream carries no avatar, so identity for a saved
/// thread comes from the directory the app already fetches. This is a pure
/// data carrier from the `command` layer into the `store` backfill — not a
/// row read back from the DB. No secrets.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdentity {
    /// The conversation id: a contact uid for a DM, a group id for a group.
    pub thread_id: String,
    /// Resolved display title (contact display name or group name), when known.
    #[serde(default)]
    pub title: Option<String>,
    /// Avatar URL, when known.
    #[serde(default)]
    pub avatar: Option<String>,
}
