use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub public_base_url: String,
    pub dev_return_magic_tokens: bool,
    pub magic_link_webhook_url: Option<String>,
    pub magic_link_smtp_addr: Option<String>,
    pub magic_link_from: String,
    pub magic_link_ttl: Duration,
    pub magic_link_rate_limit: i64,
    pub magic_link_rate_window: Duration,
    pub s3_bucket: String,
    pub s3_endpoint: Option<String>,
    pub s3_access_key_id: Option<String>,
    pub s3_secret_access_key: Option<String>,
    pub s3_allow_http: bool,
    pub master_key_seed: String,
}

impl Config {
    pub fn from_env() -> Self {
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
        let magic_link_webhook_url = std::env::var("ZCA_CLOUD_MAGIC_LINK_WEBHOOK_URL")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let magic_link_smtp_addr = std::env::var("ZCA_CLOUD_SMTP_ADDR")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let magic_link_from = std::env::var("ZCA_CLOUD_MAGIC_LINK_FROM")
            .unwrap_or_else(|_| "ZCA Cloud <no-reply@zca.local>".to_string());
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
        let master_key_seed = std::env::var("ZCA_CLOUD_MASTER_KEY")
            .unwrap_or_else(|_| "dev-only-zca-cloud-master-key-change-me".to_string());
        Self {
            bind_addr,
            database_url,
            public_base_url,
            dev_return_magic_tokens,
            magic_link_webhook_url,
            magic_link_smtp_addr,
            magic_link_from,
            magic_link_ttl,
            magic_link_rate_limit,
            magic_link_rate_window,
            s3_bucket,
            s3_endpoint,
            s3_access_key_id,
            s3_secret_access_key,
            s3_allow_http,
            master_key_seed,
        }
    }
}
