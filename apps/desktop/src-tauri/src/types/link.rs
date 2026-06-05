//! Link preview DTO surfaced to the UI (`types` layer, ADR-0003).

use serde::{Deserialize, Serialize};

/// A link preview extracted from a `chat.link` or attachment-type message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    /// The URL.
    pub href: String,
    /// Open Graph / page title.
    pub title: Option<String>,
    /// Open Graph / page description.
    pub description: Option<String>,
    /// Thumbnail image URL.
    pub thumb: Option<String>,
}
