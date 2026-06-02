//! Contact/friend DTOs surfaced to the UI (`types` layer, ADR-0003).
//!
//! Pure data: no `zca-rust` dependency. The `zalo` layer maps `zca-rust`'s
//! `User` model into these DTOs so the frontend never sees `zca-rust` types.

use serde::{Deserialize, Serialize};

use crate::types::AccountId;

/// A friend/contact entry for the address book pane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    /// The contact's Zalo uid (usable as a thread id for a DM).
    pub user_id: AccountId,
    pub display_name: String,
    /// The contact's own Zalo display name, when different from the alias.
    #[serde(default)]
    pub zalo_name: Option<String>,
    /// Avatar URL, when present.
    #[serde(default)]
    pub avatar: Option<String>,
}

/// A group/conversation entry used to resolve a group thread's name + avatar
/// (a group `thread_id` is the group id). Pure data; the `zalo` layer maps
/// `zca-rust`'s `GroupInfo` into this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// The group id (also the thread id for group messages).
    pub group_id: String,
    pub name: String,
    /// Group avatar URL, when present.
    #[serde(default)]
    pub avatar: Option<String>,
}
