use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::{AppError, AppResult, Config};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MagicLinkWebhookPayload<'a> {
    email: &'a str,
    magic_link: String,
    expires_in_secs: u64,
}

pub async fn deliver_magic_link(config: &Config, email: &str, token: &str) -> AppResult<()> {
    let magic_link = magic_link_url(config, email, token);

    if let Some(smtp_addr) = config.magic_link_smtp_addr.as_deref() {
        return deliver_magic_link_smtp(config, smtp_addr, email, &magic_link).await;
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

fn magic_link_url(config: &Config, email: &str, token: &str) -> String {
    format!(
        "{}/auth/magic-link?email={}&token={}",
        config.public_base_url.trim_end_matches('/'),
        urlencoding::encode(email),
        urlencoding::encode(token)
    )
}

async fn deliver_magic_link_smtp(
    config: &Config,
    smtp_addr: &str,
    email: &str,
    magic_link: &str,
) -> AppResult<()> {
    let from = extract_email_address(&config.magic_link_from).unwrap_or("no-reply@zca.local");
    let subject = "Your ZCA Cloud sign-in link";
    let body = format!(
        "From: {}\r\nTo: {email}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOpen this link to sign in:\r\n\r\n{magic_link}\r\n\r\nThis link expires in {} seconds.\r\n",
        config.magic_link_from,
        config.magic_link_ttl.as_secs()
    );

    let mut stream = TcpStream::connect(smtp_addr)
        .await
        .map_err(|_| AppError::ServiceUnavailable("smtp delivery failed".to_string()))?;
    read_smtp_response(&mut stream).await?;
    smtp_cmd(&mut stream, "EHLO zca-cloud.local\r\n").await?;
    smtp_cmd(&mut stream, &format!("MAIL FROM:<{from}>\r\n")).await?;
    smtp_cmd(&mut stream, &format!("RCPT TO:<{email}>\r\n")).await?;
    smtp_cmd(&mut stream, "DATA\r\n").await?;
    stream
        .write_all(format!("{}\r\n.\r\n", dot_stuff(&body)).as_bytes())
        .await
        .map_err(|_| AppError::ServiceUnavailable("smtp delivery failed".to_string()))?;
    expect_smtp_ok(&read_smtp_response(&mut stream).await?)?;
    smtp_cmd(&mut stream, "QUIT\r\n").await?;
    Ok(())
}

async fn smtp_cmd(stream: &mut TcpStream, command: &str) -> AppResult<()> {
    stream
        .write_all(command.as_bytes())
        .await
        .map_err(|_| AppError::ServiceUnavailable("smtp delivery failed".to_string()))?;
    expect_smtp_ok(&read_smtp_response(stream).await?)
}

async fn read_smtp_response(stream: &mut TcpStream) -> AppResult<String> {
    loop {
        let line = read_smtp_line(stream).await?;
        let more = line.as_bytes().get(3) == Some(&b'-');
        if !more {
            return Ok(line);
        }
    }
}

async fn read_smtp_line(stream: &mut TcpStream) -> AppResult<String> {
    let mut buf = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|_| AppError::ServiceUnavailable("smtp delivery failed".to_string()))?;
        if n == 0 {
            return Err(AppError::ServiceUnavailable(
                "smtp delivery failed".to_string(),
            ));
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n") {
            return String::from_utf8(buf)
                .map_err(|_| AppError::ServiceUnavailable("smtp delivery failed".to_string()));
        }
    }
}

fn expect_smtp_ok(line: &str) -> AppResult<()> {
    match line.as_bytes().first() {
        Some(b'2') | Some(b'3') => Ok(()),
        _ => Err(AppError::ServiceUnavailable(
            "smtp delivery failed".to_string(),
        )),
    }
}

fn extract_email_address(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if let Some(start) = trimmed.find('<') {
        let end = trimmed[start + 1..].find('>')?;
        return Some(&trimmed[start + 1..start + 1 + end]);
    }
    (!trimmed.is_empty()).then_some(trimmed)
}

fn dot_stuff(body: &str) -> String {
    body.lines()
        .map(|line| {
            if line.starts_with('.') {
                format!(".{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
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
            magic_link_webhook_url: None,
            magic_link_smtp_addr: None,
            magic_link_from: "ZCA Cloud <no-reply@zca.local>".to_string(),
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
        let config = config_without_delivery();
        let link = magic_link_url(&config, "user+test@example.com", "a token");
        assert!(link.contains("email=user%2Btest%40example.com"));
        assert!(link.contains("token=a%20token"));
    }

    #[test]
    fn extracts_mailbox_from_display_from() {
        assert_eq!(
            extract_email_address("ZCA Cloud <no-reply@zca.local>"),
            Some("no-reply@zca.local")
        );
        assert_eq!(
            extract_email_address("plain@zca.local"),
            Some("plain@zca.local")
        );
    }
}
