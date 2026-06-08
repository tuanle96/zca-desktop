use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("recovery key required")]
    RecoveryKeyRequired,
    #[error("invalid recovery key")]
    RecoveryKeyInvalid,
    #[error("not found")]
    NotFound,
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("rate limited: {0}")]
    RateLimited(String),
    #[error("crypto error")]
    Crypto,
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: &'static str,
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Internal failures (database, crypto) must never leak their detail to the
        // client: the underlying error can disclose SQL fragments, column/constraint
        // names, or storage topology. Log the detail server-side and return a generic
        // message. Client-actionable variants keep their developer-authored message.
        let (status, code, message) = match &self {
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg.clone()),
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "unauthorized".to_string(),
            ),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden", "forbidden".to_string()),
            AppError::RecoveryKeyRequired => (
                StatusCode::FORBIDDEN,
                "recovery_key_required",
                "recovery_key_required".to_string(),
            ),
            AppError::RecoveryKeyInvalid => (
                StatusCode::FORBIDDEN,
                "recovery_key_invalid",
                "recovery_key_invalid".to_string(),
            ),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not_found", "not found".to_string()),
            AppError::ServiceUnavailable(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "service_unavailable",
                msg.clone(),
            ),
            AppError::RateLimited(msg) => {
                (StatusCode::TOO_MANY_REQUESTS, "rate_limited", msg.clone())
            }
            AppError::Crypto => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "crypto_error",
                "internal server error".to_string(),
            ),
            AppError::Db(err) => {
                tracing::error!(error = %err, "database error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "database_error",
                    "internal server error".to_string(),
                )
            }
        };
        (
            status,
            Json(ErrorBody {
                error: code,
                message,
            }),
        )
            .into_response()
    }
}
