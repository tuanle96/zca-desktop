//! Callback payloads emitted from the local cloud auth loopback listener.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MagicLinkCallbackPayload {
    pub email: String,
    pub token: String,
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackPayload {
    pub code: String,
    pub base_url: String,
}
