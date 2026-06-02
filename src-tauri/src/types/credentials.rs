//! Credential DTOs — the `ZaloDataExtractor` export shape.
//!
//! Pure data in the `types` layer (ADR-0003): no `zca-rust` dependency, so the
//! forward-only order `types → … → zalo` is preserved. The `zalo` layer maps
//! this DTO into `zca_rust::zalo::Credentials` at login time.
//!
//! Security: imei + cookie + userAgent are bearer tokens. This type
//! intentionally does NOT derive `Debug`, so the values cannot be logged or
//! echoed by accident (mirrors the upstream `zca-rust` decision).

use serde::{Deserialize, Serialize};
use std::fmt;

/// One cookie entry as exported by browser tools / ZaloDataExtractor.
///
/// Optional fields default so partial exports still deserialize. Field names
/// mirror the JSON export (camelCase) for a lossless round-trip into login.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub domain: String,
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub expiration_date: Option<f64>,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub session: bool,
    #[serde(default)]
    pub store_id: Option<String>,
}

fn default_language() -> String {
    "vi".to_string()
}

/// Credentials parsed from a ZaloDataExtractor JSON export.
///
/// No `Debug` derive on purpose — see the module docs.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub imei: String,
    pub cookie: Vec<Cookie>,
    pub user_agent: String,
    #[serde(default = "default_language")]
    pub language: String,
}

/// Why a credential payload was rejected. Messages never include token values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialError {
    MissingImei,
    MissingCookies,
    MissingUserAgent,
}

impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            CredentialError::MissingImei => "credentials are missing a non-empty `imei`",
            CredentialError::MissingCookies => "credentials must include at least one cookie",
            CredentialError::MissingUserAgent => "credentials are missing a non-empty `userAgent`",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for CredentialError {}

impl Credentials {
    /// Validate required fields without revealing their values.
    pub fn validate(&self) -> Result<(), CredentialError> {
        if self.imei.trim().is_empty() {
            return Err(CredentialError::MissingImei);
        }
        if self.cookie.is_empty() {
            return Err(CredentialError::MissingCookies);
        }
        if self.user_agent.trim().is_empty() {
            return Err(CredentialError::MissingUserAgent);
        }
        Ok(())
    }
}
