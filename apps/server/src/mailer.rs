use lettre::message::header::ContentType;
use lettre::message::{MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Serialize;

use crate::{AppError, AppResult, Config};

const RESEND_EMAILS_ENDPOINT: &str = "https://api.resend.com/emails";
const MAGIC_LINK_SUBJECT: &str = "Your ZCA Cloud sign-in link";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MagicLinkWebhookPayload<'a> {
    email: &'a str,
    magic_link: String,
    expires_in_secs: u64,
}

#[derive(Debug, Serialize)]
struct ResendEmailPayload<'a> {
    from: &'a str,
    to: &'a str,
    subject: &'a str,
    html: String,
    text: String,
}

struct MagicLinkEmail {
    html: String,
    text: String,
}

pub async fn deliver_magic_link(config: &Config, email: &str, token: &str) -> AppResult<()> {
    let magic_link = magic_link_url(config, email, token);

    if let Some(api_key) = config.magic_link_resend_api_key.as_deref() {
        return deliver_magic_link_resend(config, api_key, email, &magic_link, token).await;
    }

    if let Some(smtp_addr) = config.magic_link_smtp_addr.as_deref() {
        return deliver_magic_link_smtp(config, smtp_addr, email, &magic_link, token).await;
    }

    let Some(webhook_url) = config.magic_link_webhook_url.as_deref() else {
        if config.dev_return_magic_tokens {
            return Ok(());
        }
        return Err(AppError::ServiceUnavailable(
            "magic-link delivery is not configured".to_string(),
        ));
    };

    let payload = MagicLinkWebhookPayload {
        email,
        magic_link,
        expires_in_secs: config.magic_link_ttl.as_secs(),
    };

    let res = reqwest::Client::new()
        .post(webhook_url)
        .json(&payload)
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("magic-link delivery failed".to_string()))?;
    if !res.status().is_success() {
        return Err(AppError::ServiceUnavailable(
            "magic-link delivery failed".to_string(),
        ));
    }
    Ok(())
}

fn build_magic_link_email(config: &Config, magic_link: &str, token: &str) -> MagicLinkEmail {
    let ttl_secs = config.magic_link_ttl.as_secs();
    let text = format!(
        "Open this link to sign in:\r\n\r\n{magic_link}\r\n\r\n\
         If the link doesn't open the app (e.g. during development), paste this \
         code into the app's sign-in field:\r\n\r\n{token}\r\n\r\n\
         This link expires in {ttl_secs} seconds.\r\n",
    );

    let link_attr = html_escape(magic_link);
    let link_text = html_escape(magic_link);
    let code_text = html_escape(token);
    let html = format!(
        "<p>Click to sign in to ZCA Cloud:</p>\
         <p><a href=\"{link_attr}\">{link_text}</a></p>\
         <p>If the link doesn't open the app (e.g. during development), paste this \
         code into the app's sign-in field:</p>\
         <p><code>{code_text}</code></p>\
         <p>This link expires in {ttl_secs} seconds.</p>",
    );

    MagicLinkEmail { html, text }
}

fn build_resend_payload<'a>(
    config: &'a Config,
    email: &'a str,
    magic_link: &str,
    token: &str,
) -> ResendEmailPayload<'a> {
    let body = build_magic_link_email(config, magic_link, token);
    ResendEmailPayload {
        from: &config.magic_link_from,
        to: email,
        subject: MAGIC_LINK_SUBJECT,
        html: body.html,
        text: body.text,
    }
}

async fn deliver_magic_link_resend(
    config: &Config,
    api_key: &str,
    email: &str,
    magic_link: &str,
    token: &str,
) -> AppResult<()> {
    let payload = build_resend_payload(config, email, magic_link, token);
    let res = reqwest::Client::new()
        .post(RESEND_EMAILS_ENDPOINT)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|_| AppError::ServiceUnavailable("resend delivery failed".to_string()))?;

    if !res.status().is_success() {
        return Err(AppError::ServiceUnavailable(
            "resend delivery failed".to_string(),
        ));
    }

    Ok(())
}

/// Minimal HTML escaping for embedding the magic link/token in the HTML email
/// part. Covers the characters that matter for attribute and text contexts.
fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn magic_link_url(config: &Config, email: &str, token: &str) -> String {
    // ADR-0009: prefer the desktop deep-link scheme so clicking the email opens
    // the app and auto-verifies. Fall back to the HTTPS form when the scheme is
    // explicitly disabled (empty).
    if !config.app_link_scheme.is_empty() {
        return format!(
            "{}://magic-link?email={}&token={}",
            config.app_link_scheme,
            urlencoding::encode(email),
            urlencoding::encode(token)
        );
    }
    format!(
        "{}/auth/magic-link?email={}&token={}",
        config.public_base_url.trim_end_matches('/'),
        urlencoding::encode(email),
        urlencoding::encode(token)
    )
}

/// Deliver the login link over SMTP using a TLS-capable client (lettre).
///
/// When `ZCA_CLOUD_SMTP_TLS` is enabled (the default) the connection uses STARTTLS
/// (or implicit TLS on port 465) and, when credentials are configured, SMTP AUTH —
/// so the sign-in token is not exposed in cleartext on the wire. Set the TLS flag
/// to `0` only for a trusted plaintext relay on localhost (e.g. MailHog in dev).
async fn deliver_magic_link_smtp(
    config: &Config,
    smtp_addr: &str,
    email: &str,
    magic_link: &str,
    token: &str,
) -> AppResult<()> {
    let (host, port) = parse_smtp_addr(smtp_addr)?;

    let from = config
        .magic_link_from
        .parse()
        .map_err(|_| AppError::ServiceUnavailable("invalid magic-link from address".to_string()))?;
    let to = email
        .parse()
        .map_err(|_| AppError::BadRequest("a valid email is required".to_string()))?;
    // HTML alternative: the clickable link lives in an <a href>, so even if the
    // raw URL is long it cannot be truncated by quoted-printable line wrapping
    // (which silently cut the token off the plain-text link). See ADR-0009.
    let body = build_magic_link_email(config, magic_link, token);
    let message = Message::builder()
        .from(from)
        .to(to)
        .subject(MAGIC_LINK_SUBJECT)
        .multipart(
            MultiPart::alternative()
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_PLAIN)
                        .body(body.text),
                )
                .singlepart(
                    SinglePart::builder()
                        .header(ContentType::TEXT_HTML)
                        .body(body.html),
                ),
        )
        .map_err(|_| AppError::ServiceUnavailable("failed to build sign-in email".to_string()))?;

    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&host).port(port);
    if config.magic_link_smtp_tls {
        let tls_params = TlsParameters::new(host.clone())
            .map_err(|_| AppError::ServiceUnavailable("smtp tls setup failed".to_string()))?;
        let tls = if port == 465 {
            Tls::Wrapper(tls_params)
        } else {
            Tls::Required(tls_params)
        };
        builder = builder.tls(tls);
    }
    if let (Some(user), Some(pass)) = (
        config.magic_link_smtp_username.as_deref(),
        config.magic_link_smtp_password.as_deref(),
    ) {
        builder = builder.credentials(Credentials::new(user.to_string(), pass.to_string()));
    }

    builder
        .build()
        .send(message)
        .await
        .map_err(|_| AppError::ServiceUnavailable("smtp delivery failed".to_string()))?;
    Ok(())
}

fn parse_smtp_addr(addr: &str) -> AppResult<(String, u16)> {
    match addr.rsplit_once(':') {
        Some((host, port)) => {
            let port = port
                .parse::<u16>()
                .map_err(|_| AppError::ServiceUnavailable("invalid smtp port".to_string()))?;
            Ok((host.to_string(), port))
        }
        None => Ok((addr.to_string(), 587)),
    }
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;

    use super::*;

    fn config_without_delivery() -> Config {
        Config {
            bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 37880),
            database_url: "postgres://postgres:postgres@localhost:5432/zca_cloud".to_string(),
            public_base_url: "http://localhost:37880".to_string(),
            dev_return_magic_tokens: false,
            magic_link_resend_api_key: None,
            magic_link_webhook_url: None,
            magic_link_smtp_addr: None,
            magic_link_from: "ZCA Cloud <no-reply@zca.local>".to_string(),
            magic_link_smtp_username: None,
            magic_link_smtp_password: None,
            magic_link_smtp_tls: true,
            app_link_scheme: "zca".to_string(),
            magic_link_ttl: Duration::from_secs(600),
            magic_link_rate_limit: 5,
            magic_link_rate_window: Duration::from_secs(900),
            s3_bucket: "test".to_string(),
            s3_endpoint: None,
            s3_access_key_id: None,
            s3_secret_access_key: None,
            s3_allow_http: false,
            media_mirror_max_bytes: 25 * 1024 * 1024,
            master_key_seed: "test-master-key".to_string(),
            allowed_origins: Vec::new(),
        }
    }

    #[tokio::test]
    async fn production_mode_requires_delivery_configuration() {
        let err = deliver_magic_link(&config_without_delivery(), "user@example.com", "token")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::ServiceUnavailable(_)));
    }

    #[test]
    fn magic_link_url_encodes_email_and_token() {
        // Default config uses the zca:// deep-link scheme (ADR-0009).
        let config = config_without_delivery();
        let link = magic_link_url(&config, "user+test@example.com", "a token");
        assert!(link.starts_with("zca://magic-link?"));
        assert!(link.contains("email=user%2Btest%40example.com"));
        assert!(link.contains("token=a%20token"));
    }

    #[test]
    fn magic_link_url_falls_back_to_https_when_scheme_disabled() {
        let mut config = config_without_delivery();
        config.app_link_scheme = String::new();
        let link = magic_link_url(&config, "user+test@example.com", "a token");
        assert!(link.starts_with("http://localhost:37880/auth/magic-link?"));
        assert!(link.contains("email=user%2Btest%40example.com"));
        assert!(link.contains("token=a%20token"));
    }

    #[test]
    fn parses_smtp_addr() {
        assert_eq!(
            parse_smtp_addr("smtp.example.com:587").unwrap(),
            ("smtp.example.com".to_string(), 587)
        );
        assert_eq!(
            parse_smtp_addr("mailhog").unwrap(),
            ("mailhog".to_string(), 587)
        );
        assert!(parse_smtp_addr("host:notaport").is_err());
    }

    #[test]
    fn resend_payload_uses_configured_sender_and_preserves_magic_link() {
        let config = config_without_delivery();
        let payload = build_resend_payload(
            &config,
            "user@example.com",
            "zca://magic-link?email=user%40example.com&token=a%20token",
            "a token",
        );
        let json = serde_json::to_value(&payload).unwrap();

        assert_eq!(json["from"], "ZCA Cloud <no-reply@zca.local>");
        assert_eq!(json["to"], "user@example.com");
        assert_eq!(json["subject"], MAGIC_LINK_SUBJECT);
        assert!(json["text"]
            .as_str()
            .unwrap()
            .contains("zca://magic-link?email=user%40example.com&token=a%20token"));
        assert!(json["html"].as_str().unwrap().contains("a%20token"));
    }
}
