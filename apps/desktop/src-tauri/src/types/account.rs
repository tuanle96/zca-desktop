//! Account-facing DTOs returned to the UI.
//!
//! Pure data (`types` layer, ADR-0003). These carry NO secrets — only the
//! public account id/display fields the UI shows. Credentials never cross this
//! boundary into the frontend.

use serde::{Deserialize, Serialize};

/// Stable per-account identifier (the Zalo uid).
pub type AccountId = String;

/// Public profile of a logged-in account, safe to render in the UI.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub account_id: AccountId,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Public avatar URL for the logged-in account, when available.
    #[serde(default)]
    pub avatar: Option<String>,
}

/// Non-secret result of importing a credential payload.
///
/// Returned to the UI after `import_credentials` so the frontend can confirm a
/// valid import WITHOUT ever receiving the imei/cookie/userAgent values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    /// imei is itself a bearer token, so we expose only its length, never the value.
    pub imei_len: usize,
    pub cookie_count: usize,
    pub user_agent_len: usize,
    pub language: String,
}
