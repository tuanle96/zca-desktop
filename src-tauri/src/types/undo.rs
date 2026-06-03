//! Undo (delete message) event DTO (`types` layer, ADR-0003).

use serde::{Deserialize, Serialize};

/// An undo event — someone deleted a message (or the current account deleted
/// their own message). The UI removes the message from the thread view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UndoEvent {
    pub thread_id: String,
    pub msg_id: String,
    pub cli_msg_id: String,
    pub is_self: bool,
    pub is_group: bool,
}
