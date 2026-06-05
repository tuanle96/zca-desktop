use axum::async_trait;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use std::sync::Arc;

use crate::crypto;
use crate::db::AuthDevice;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;

#[derive(Debug, Clone)]
pub struct Auth(pub AuthDevice);

#[async_trait]
impl FromRequestParts<Arc<AppState>> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(AppError::Unauthorized)?;
        let device = state.db.auth_device(&crypto::token_hash(token)).await?;
        Ok(Auth(device))
    }
}

pub fn normalize_email(email: &str) -> AppResult<String> {
    let email = email.trim().to_lowercase();
    // Reject control characters (CR, LF, NUL, ...) before the address is ever
    // interpolated into SMTP commands / mail headers. This closes the
    // email-header / SMTP-injection vector in the mailer (an embedded "\r\n"
    // would otherwise let a caller inject extra recipients or forged headers).
    if email.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(AppError::BadRequest(
            "a valid email is required".to_string(),
        ));
    }
    if !email.contains('@') || email.len() > 320 {
        return Err(AppError::BadRequest(
            "a valid email is required".to_string(),
        ));
    }
    Ok(email)
}

pub fn validate_device_name(name: &str) -> AppResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::BadRequest("device name is required".to_string()));
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_email() {
        assert_eq!(
            normalize_email(" User@Example.COM ").unwrap(),
            "user@example.com"
        );
        assert!(normalize_email("not-email").is_err());
    }

    #[test]
    fn rejects_header_injection() {
        assert!(normalize_email("a@b.com\r\nRCPT TO:<victim@x>").is_err());
        assert!(normalize_email("a@b.com\nBcc: evil@example.com").is_err());
        assert!(normalize_email("a@b.com\u{0000}").is_err());
    }
}
