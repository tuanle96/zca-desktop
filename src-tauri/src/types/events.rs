//! Realtime event DTOs surfaced to the UI (`types` layer, ADR-0003).
//!
//! Pure data: no `zca-rust` dependency. The `zalo` layer maps `zca-rust`'s
//! `ListenerEvent` into these DTOs so the rest of the core (and the frontend)
//! never sees `zca-rust` types directly.

use serde::{Deserialize, Serialize};

use crate::types::AccountId;

/// Which kind of thread a message belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadKind {
    User,
    Group,
}

/// A normalized incoming message for the UI.
///
/// Carries only display-relevant fields; no credential or session state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingMessage {
    /// Account that received this event (whose listener emitted it).
    pub account_id: AccountId,
    /// Conversation id (peer uid for DMs, group id for groups).
    pub thread_id: String,
    pub thread_kind: ThreadKind,
    /// Sender uid.
    pub from_id: String,
    /// Sender display name, when the event carries one.
    #[serde(default)]
    pub from_name: Option<String>,
    /// Plain-text body when the message is text; `None` for non-text content.
    #[serde(default)]
    pub text: Option<String>,
    pub msg_id: String,
    /// Server timestamp string as provided by Zalo.
    pub timestamp: String,
    /// True when this account sent the message (echo / multi-device).
    pub is_self: bool,
}
