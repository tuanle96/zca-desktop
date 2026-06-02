//! `zalo` layer — thin wrapper over the `zca-rust` client.
//!
//! ADR-0003 layer order: `types → config → store → zalo → session → command`.
//! This layer is the only place that talks to `zca-rust`; higher layers
//! (`session`, `command`) depend on this wrapper, never on `zca-rust` directly.
//! It also maps the core `types::Credentials` DTO into `zca-rust`'s credential
//! type so the `types` layer stays free of any `zca-rust` dependency.
//!
//! Security: credentials (imei + cookie + userAgent) are bearer tokens.
//! This module never logs or echoes their values.

pub use zca_rust::{Result as ZaloResult, ZaloError, API};

use zca_rust::zalo::{Cookie as ZcaCookie, Credentials as ZcaCredentials};
use zca_rust::Zalo;

use crate::types::{AccountProfile, Credentials};

/// Map the core credential DTO into the `zca-rust` credential type.
///
/// Kept inside the `zalo` layer so `types` never depends on `zca-rust`.
fn to_zca_credentials(credentials: &Credentials) -> ZcaCredentials {
    // `ZcaCredentials`/`ZcaCookie` derive `Deserialize` with camelCase; rebuild
    // them via JSON so this mapping stays correct if upstream adds fields.
    let cookies: Vec<ZcaCookie> = credentials
        .cookie
        .iter()
        .filter_map(|c| serde_json::to_value(c).ok().and_then(|v| serde_json::from_value(v).ok()))
        .collect();
    ZcaCredentials {
        imei: credentials.imei.clone(),
        cookie: cookies,
        user_agent: credentials.user_agent.clone(),
        language: credentials.language.clone(),
    }
}

/// Cookie-based login. Returns an authenticated [`API`] facade on success.
///
/// Credentials are validated by `zca-rust` before any network call: empty
/// imei/cookie/userAgent fail fast with [`ZaloError::Api`].
pub async fn login(credentials: Credentials) -> ZaloResult<API> {
    Zalo::new(None).login(to_zca_credentials(&credentials)).await
}

/// Log in and return the account's public profile (id + best-effort name).
///
/// `account_id` comes from `getOwnId` (always present after login). The display
/// name is best-effort: a failed profile fetch leaves it `None` rather than
/// failing the whole login.
pub async fn login_profile(credentials: Credentials) -> ZaloResult<AccountProfile> {
    let api = login(credentials).await?;
    let account_id = api.get_own_id().to_string();
    let display_name = fetch_display_name(&api).await;
    Ok(AccountProfile { account_id, display_name })
}

/// Best-effort own display name; returns `None` on any error or empty value.
async fn fetch_display_name(api: &API) -> Option<String> {
    let info = zca_rust::apis::fetch_account_info::fetch_account_info(api.get_context())
        .await
        .ok()?;
    let name = info.profile.display_name.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Credentials;

    fn blank_credentials() -> Credentials {
        Credentials {
            imei: String::new(),
            cookie: Vec::new(),
            user_agent: String::new(),
            language: "vi".to_string(),
        }
    }

    /// Empty credentials must fail fast (offline) instead of attempting a
    /// network login — proves the wrapper is wired to `zca-rust` validation.
    #[tokio::test]
    async fn login_rejects_empty_credentials() {
        // `API` does not implement `Debug`, so match instead of `expect_err`.
        match login(blank_credentials()).await {
            Ok(_) => panic!("empty credentials must not produce a session"),
            Err(err) => assert!(matches!(err, ZaloError::Api { .. }), "expected API error, got {err}"),
        }
    }

    /// Same guard for the profile path.
    #[tokio::test]
    async fn login_profile_rejects_empty_credentials() {
        let err = login_profile(blank_credentials()).await.expect_err("empty creds must error");
        assert!(matches!(err, ZaloError::Api { .. }), "expected API error, got {err}");
    }

    /// Live single-login smoke. Ignored by default: it performs a REAL network
    /// login and requires a populated `.zalo-cred.json` (gitignored) at the repo
    /// root. Run explicitly:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored single_login_live
    /// Prints only non-secret facts (uid length, whether a display name exists);
    /// it never echoes imei/cookie/userAgent.
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; performs a live network login"]
    async fn single_login_live() {
        let raw = std::fs::read_to_string("../.zalo-cred.json")
            .expect("create .zalo-cred.json at repo root from .zalo-cred.example.json");
        let credentials: Credentials =
            serde_json::from_str(&raw).expect(".zalo-cred.json must be valid Credentials JSON");
        credentials.validate().expect(".zalo-cred.json is missing required fields");

        let profile = login_profile(credentials).await.expect("live login failed");

        assert!(!profile.account_id.is_empty(), "account_id must be non-empty after login");
        // Non-secret diagnostics only.
        println!(
            "single_login_live OK: uid_len={} has_display_name={}",
            profile.account_id.len(),
            profile.display_name.is_some()
        );
    }
}
