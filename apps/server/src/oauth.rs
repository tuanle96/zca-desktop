use std::time::Duration;

use reqwest::header;
use serde::Deserialize;

use crate::{AppError, AppResult};

const OAUTH_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OAuthProvider {
    Google,
    Github,
}

#[derive(Debug)]
pub(crate) struct OAuthProfile {
    pub(crate) subject: String,
    pub(crate) email: String,
    pub(crate) email_verified: bool,
}

impl OAuthProvider {
    pub(crate) fn parse(provider: &str) -> AppResult<Self> {
        match provider {
            "google" => Ok(Self::Google),
            "github" => Ok(Self::Github),
            _ => Err(AppError::NotFound),
        }
    }

    pub(crate) fn slug(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Github => "github",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::Github => "GitHub",
        }
    }

    pub(crate) fn client(self, config: &crate::Config) -> AppResult<(&str, &str)> {
        let pair = match self {
            Self::Google => (
                config.oauth_google_client_id.as_deref(),
                config.oauth_google_client_secret.as_deref(),
            ),
            Self::Github => (
                config.oauth_github_client_id.as_deref(),
                config.oauth_github_client_secret.as_deref(),
            ),
        };
        match pair {
            (Some(client_id), Some(client_secret))
                if !client_id.trim().is_empty() && !client_secret.trim().is_empty() =>
            {
                Ok((client_id.trim(), client_secret.trim()))
            }
            _ => Err(AppError::BadRequest(format!(
                "{} OAuth is not configured",
                self.label()
            ))),
        }
    }

    pub(crate) fn authorize_url(self) -> &'static str {
        match self {
            Self::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            Self::Github => "https://github.com/login/oauth/authorize",
        }
    }

    pub(crate) fn scope(self) -> &'static str {
        match self {
            Self::Google => "openid email profile",
            Self::Github => "user:email",
        }
    }

    pub(crate) fn configured(self, config: &crate::Config) -> bool {
        match self {
            Self::Google => {
                config
                    .oauth_google_client_id
                    .as_deref()
                    .is_some_and(|v| !v.trim().is_empty())
                    && config
                        .oauth_google_client_secret
                        .as_deref()
                        .is_some_and(|v| !v.trim().is_empty())
            }
            Self::Github => {
                config
                    .oauth_github_client_id
                    .as_deref()
                    .is_some_and(|v| !v.trim().is_empty())
                    && config
                        .oauth_github_client_secret
                        .as_deref()
                        .is_some_and(|v| !v.trim().is_empty())
            }
        }
    }
}

pub(crate) async fn fetch_oauth_profile(
    config: &crate::Config,
    provider: OAuthProvider,
    code: &str,
) -> AppResult<OAuthProfile> {
    match provider {
        OAuthProvider::Google => fetch_google_profile(config, provider, code).await,
        OAuthProvider::Github => fetch_github_profile(config, provider, code).await,
    }
}

pub(crate) fn oauth_redirect_uri(config: &crate::Config, provider: OAuthProvider) -> String {
    format!(
        "{}/auth/oauth/{}/callback",
        config.public_base_url.trim_end_matches('/'),
        provider.slug()
    )
}

fn oauth_http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(OAUTH_HTTP_TIMEOUT)
        .build()
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))
}

async fn fetch_google_profile(
    config: &crate::Config,
    provider: OAuthProvider,
    code: &str,
) -> AppResult<OAuthProfile> {
    let (client_id, client_secret) = provider.client(config)?;
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
    }
    #[derive(Deserialize)]
    struct UserInfo {
        sub: String,
        email: String,
        #[serde(default)]
        email_verified: bool,
    }
    let http = oauth_http_client()?;
    let redirect_uri = oauth_redirect_uri(config, provider);
    let token = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    if !token.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let token = token
        .json::<TokenResponse>()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    let user = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(token.access_token)
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    if !user.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let user = user
        .json::<UserInfo>()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    Ok(OAuthProfile {
        subject: user.sub,
        email: user.email,
        email_verified: user.email_verified,
    })
}

async fn fetch_github_profile(
    config: &crate::Config,
    provider: OAuthProvider,
    code: &str,
) -> AppResult<OAuthProfile> {
    let (client_id, client_secret) = provider.client(config)?;
    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
    }
    #[derive(Deserialize)]
    struct GithubUser {
        id: u64,
    }
    #[derive(Deserialize)]
    struct GithubEmail {
        email: String,
        #[serde(default)]
        primary: bool,
        #[serde(default)]
        verified: bool,
    }
    let http = oauth_http_client()?;
    let redirect_uri = oauth_redirect_uri(config, provider);
    let token = http
        .post("https://github.com/login/oauth/access_token")
        .header(header::ACCEPT, "application/json")
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", redirect_uri.as_str()),
        ])
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    if !token.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let token = token
        .json::<TokenResponse>()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    let user = http
        .get("https://api.github.com/user")
        .header(header::USER_AGENT, "zca-cloud")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    if !user.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let user = user
        .json::<GithubUser>()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    let emails = http
        .get("https://api.github.com/user/emails")
        .header(header::USER_AGENT, "zca-cloud")
        .bearer_auth(token.access_token)
        .send()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    if !emails.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let emails = emails
        .json::<Vec<GithubEmail>>()
        .await
        .map_err(|e| AppError::ServiceUnavailable(e.to_string()))?;
    let email = emails
        .iter()
        .find(|email| email.primary && email.verified)
        .or_else(|| emails.iter().find(|email| email.verified))
        .ok_or(AppError::Unauthorized)?;
    Ok(OAuthProfile {
        subject: user.id.to_string(),
        email: email.email.clone(),
        email_verified: email.verified,
    })
}
