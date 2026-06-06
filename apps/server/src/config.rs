use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub public_base_url: String,
    pub dev_return_magic_tokens: bool,
    pub magic_link_resend_api_key: Option<String>,
    pub magic_link_webhook_url: Option<String>,
    pub magic_link_smtp_addr: Option<String>,
    pub magic_link_from: String,
    pub magic_link_smtp_username: Option<String>,
    pub magic_link_smtp_password: Option<String>,
    pub magic_link_smtp_tls: bool,
    /// Custom URL scheme for opening the desktop app from the HTTPS magic-link
    /// landing page. Email clients receive HTTPS links because many of them block
    /// custom schemes in message CTAs.
    pub app_link_scheme: String,
    pub magic_link_ttl: Duration,
    pub magic_link_rate_limit: i64,
    pub magic_link_rate_window: Duration,
    pub s3_bucket: String,
    pub s3_endpoint: Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_allow_http: bool,
    pub media_mirror_max_bytes: usize,
    pub master_key_seed: String,
    pub allowed_origins: Vec<String>,
}

/// The built-in placeholder that must never be accepted as a real master key.
const INSECURE_MASTER_KEY_PLACEHOLDER: &str = "dev-only-zca-cloud-master-key-change-me";

impl Config {
    pub fn magic_link_delivery_configured(&self) -> bool {
        self.magic_link_resend_api_key.is_some()
            || self.magic_link_smtp_addr.is_some()
            || self.magic_link_webhook_url.is_some()
    }

    pub fn from_env() -> Result<Self, String> {
        let bind_addr = std::env::var("ZCA_CLOUD_BIND")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 37880));
        let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://postgres:postgres@localhost:5432/zca_cloud".to_string()
        });
        let public_base_url = std::env::var("ZCA_CLOUD_PUBLIC_BASE_URL")
            .unwrap_or_else(|_| format!("http://{bind_addr}"));
        let dev_return_magic_tokens = std::env::var("ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS")
            .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let magic_link_resend_api_key = std::env::var("ZCA_CLOUD_RESEND_API_KEY")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let magic_link_webhook_url = std::env::var("ZCA_CLOUD_MAGIC_LINK_WEBHOOK_URL")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let magic_link_smtp_addr = std::env::var("ZCA_CLOUD_SMTP_ADDR")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let magic_link_from = std::env::var("ZCA_CLOUD_MAGIC_LINK_FROM")
            .unwrap_or_else(|_| "ZCA Cloud <no-reply@zca.local>".to_string());
        let magic_link_smtp_username = std::env::var("ZCA_CLOUD_SMTP_USERNAME")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let magic_link_smtp_password = std::env::var("ZCA_CLOUD_SMTP_PASSWORD")
            .ok()
            .filter(|v| !v.is_empty());
        // TLS on by default; set ZCA_CLOUD_SMTP_TLS=0 only for a trusted plaintext
        // relay on localhost (e.g. MailHog in dev).
        let magic_link_smtp_tls = std::env::var("ZCA_CLOUD_SMTP_TLS")
            .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
            .unwrap_or(true);
        // Deep-link scheme for the desktop app (ADR-0009). Defaults to `zca`.
        // Set to an empty string to disable and fall back to the HTTPS link.
        let app_link_scheme = std::env::var("ZCA_CLOUD_APP_LINK_SCHEME")
            .map(|v| v.trim().trim_end_matches("://").to_string())
            .unwrap_or_else(|_| "zca".to_string());
        let magic_link_ttl = std::env::var("ZCA_CLOUD_MAGIC_LINK_TTL_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(10 * 60));
        let magic_link_rate_limit = std::env::var("ZCA_CLOUD_MAGIC_LINK_RATE_LIMIT")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(5);
        let magic_link_rate_window = std::env::var("ZCA_CLOUD_MAGIC_LINK_RATE_WINDOW_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(15 * 60));
        let s3_bucket =
            std::env::var("ZCA_CLOUD_S3_BUCKET").unwrap_or_else(|_| "zca-cloud-dev".to_string());
        let s3_endpoint = std::env::var("ZCA_CLOUD_S3_ENDPOINT").ok();
        let s3_access_key_id = std::env::var("AWS_ACCESS_KEY_ID").ok();
        let s3_secret_access_key = std::env::var("AWS_SECRET_ACCESS_KEY").ok();
        let s3_allow_http = std::env::var("ZCA_CLOUD_S3_ALLOW_HTTP")
            .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        let media_mirror_max_bytes = std::env::var("ZCA_CLOUD_MEDIA_MIRROR_MAX_BYTES")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(25 * 1024 * 1024);

        // Security-critical: this seed wraps every user's data key, which in turn
        // encrypts stored Zalo sessions, messages, and files. It must be provided
        // explicitly — there is deliberately NO fallback, so a misconfigured deployment
        // fails closed instead of silently encrypting everything under a public default.
        let master_key_seed = std::env::var("ZCA_CLOUD_MASTER_KEY")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .ok_or_else(|| {
                "ZCA_CLOUD_MASTER_KEY is required: set a strong, unique secret \
                 (e.g. `openssl rand -base64 48`)"
                    .to_string()
            })?;
        if master_key_seed == INSECURE_MASTER_KEY_PLACEHOLDER {
            return Err(
                "ZCA_CLOUD_MASTER_KEY is set to the built-in insecure placeholder; \
                 generate a real secret (e.g. `openssl rand -base64 48`)"
                    .to_string(),
            );
        }
        if master_key_seed.len() < 32 {
            return Err(
                "ZCA_CLOUD_MASTER_KEY must be at least 32 characters of high-entropy secret"
                    .to_string(),
            );
        }

        // Optional explicit browser CORS allow-list (comma-separated origins). The
        // desktop client talks to this API from a native HTTP client (not subject to
        // CORS), so when this is unset we emit no permissive CORS headers — see
        // routes::build_cors_layer.
        let allowed_origins = std::env::var("ZCA_CLOUD_ALLOWED_ORIGINS")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        // Refuse to expose the dev-only "return the magic token in the API response"
        // behaviour on a non-loopback bind — that flag fully bypasses email-based auth.
        if dev_return_magic_tokens && !bind_addr.ip().is_loopback() {
            return Err(
                "ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS must not be enabled on a non-loopback bind \
                 (it returns sign-in tokens in API responses and bypasses auth)"
                    .to_string(),
            );
        }

        Ok(Self {
            bind_addr,
            database_url,
            public_base_url,
            dev_return_magic_tokens,
            magic_link_resend_api_key,
            magic_link_webhook_url,
            magic_link_smtp_addr,
            magic_link_from,
            magic_link_smtp_username,
            magic_link_smtp_password,
            magic_link_smtp_tls,
            app_link_scheme,
            magic_link_ttl,
            magic_link_rate_limit,
            magic_link_rate_window,
            s3_bucket,
            s3_endpoint,
            s3_access_key_id,
            s3_secret_access_key,
            s3_allow_http,
            media_mirror_max_bytes,
            master_key_seed,
            allowed_origins,
        })
    }
}
