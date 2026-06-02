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
