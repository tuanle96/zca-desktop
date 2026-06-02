//! `zalo` layer — thin wrapper over the `zca-rust` client.
//!
//! ADR-0003 layer order: `types → config → store → zalo → session → command`.
//! This layer is the only place that talks to `zca-rust`; higher layers
//! (`session`, `command`) depend on this wrapper, never on `zca-rust` directly.
//!
//! Security: [`Credentials`] (imei + cookie + userAgent) are bearer tokens.
//! This module never logs or echoes their values.

pub use zca_rust::zalo::Credentials;
pub use zca_rust::{Result as ZaloResult, ZaloError, API};

use zca_rust::Zalo;

/// Wrap `Zalo::new().login()` and return an authenticated [`API`] facade.
///
/// Credentials are validated by `zca-rust` before any network call: empty
/// imei/cookie/userAgent fail fast with [`ZaloError::Api`].
pub async fn login(credentials: Credentials) -> ZaloResult<API> {
    Zalo::new(None).login(credentials).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank_credentials() -> Credentials {
        // Built directly (not deserialized) to exercise the wrapper's
        // validation path without embedding any real bearer token.
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
}
