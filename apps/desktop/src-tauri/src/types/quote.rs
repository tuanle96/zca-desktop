//! Quote/reply DTOs surfaced to the UI (`types` layer, ADR-0003).
//!
//! Pure data: no `zca-rust` dependency. The `zalo` layer maps `zca-rust`'s
//! `Quote` struct and `SendMessageQuote` into these DTOs.

use serde::{Deserialize, Serialize};

/// A reference to a quoted (replied-to) message, carried on incoming messages.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuoteRef {
    /// Who sent the quoted message.
    pub owner_id: String,
    /// Display name of the quoted message's sender.
    pub from_d: String,
    /// The quoted message's global id.
    pub global_msg_id: i64,
    /// The quoted message's client id.
    pub cli_msg_id: i64,
    /// The quoted message text (may be truncated).
    pub msg: String,
    /// Client message type (1=text, 7=sticker, etc.).
    pub cli_msg_type: i64,
    /// Timestamp of the quoted message.
    pub ts: i64,
}

/// What the UI sends to quote a message when replying.
/// Mirrors the fields `zca-rust`'s `SendMessageQuote` needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteInput {
    /// Text content of the quoted message.
    pub content: String,
    /// Message type of the quoted message (e.g. "webchat", "chat.sticker").
    pub msg_type: String,
    /// Who sent the quoted message.
    pub uid_from: String,
    /// Global message id of the quoted message.
    pub msg_id: String,
    /// Client message id.
    pub cli_msg_id: String,
    /// Timestamp.
    pub ts: i64,
    /// TTL (0 for normal messages).
    pub ttl: i64,
}
