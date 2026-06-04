use std::convert::Infallible;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{Duration as ChronoDuration, Utc};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::auth::{normalize_email, validate_device_name, Auth};
use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::sessions::HostedSessionManager;

pub struct AppState {
    pub config: crate::Config,
    pub db: crate::Db,
    pub sessions: HostedSessionManager,
    pub objects: Arc<dyn object_store::ObjectStore>,
    events: broadcast::Sender<RealtimeEvent>,
}

impl AppState {
    pub fn new(config: crate::Config, db: crate::Db) -> Self {
        let (events, _) = broadcast::channel(512);
        let objects = crate::storage::build_s3_store(&config)
            .unwrap_or_else(|_| Box::new(object_store::memory::InMemory::new()));
        Self {
            config,
            db,
            sessions: HostedSessionManager::default(),
            objects: Arc::from(objects),
            events,
        }
    }

    pub fn events(&self) -> broadcast::Sender<RealtimeEvent> {
        self.events.clone()
    }
}

type OptionalCiphertext = (Option<Vec<u8>>, Option<Vec<u8>>);

struct OutgoingFileMessage<'a> {
    user_id: Uuid,
    account_id: Uuid,
    account: &'a AccountView,
    thread_id: &'a str,
    kind: &'a str,
    msg_id: &'a str,
    body: &'a str,
    file: &'a RichFile,
}

pub fn app(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/v1/auth/magic-link/request", post(request_magic_link))
        .route("/api/v1/auth/magic-link/verify", post(verify_magic_link))
        .route("/api/v1/devices", get(list_devices).post(register_device))
        .route("/api/v1/devices/:device_id", delete(revoke_device))
        .route("/api/v1/accounts", get(list_accounts))
        .route("/api/v1/accounts/qr/start", post(start_account_qr))
        .route("/api/v1/accounts/qr/:flow_id", get(qr_status))
        .route("/api/v1/accounts/:account_id/status", get(account_status))
        .route("/api/v1/accounts/:account_id", delete(delete_account))
        .route(
            "/api/v1/accounts/:account_id/resolve/phone",
            post(resolve_phone),
        )
        .route("/api/v1/accounts/:account_id/send/text", post(send_text))
        .route(
            "/api/v1/accounts/:account_id/send/sticker",
            post(send_sticker),
        )
        .route(
            "/api/v1/accounts/:account_id/send/reaction",
            post(send_reaction),
        )
        .route("/api/v1/accounts/:account_id/send/file", post(send_file))
        .route("/api/v1/conversations", get(list_conversations))
        .route(
            "/api/v1/conversations/:conversation_id/messages",
            get(list_messages),
        )
        .route("/api/v1/files/init", post(init_file))
        .route("/api/v1/files/:file_id", get(get_file))
        .route(
            "/api/v1/files/:file_id/blob",
            get(download_file_blob).post(upload_file_blob),
        )
        .route("/api/v1/realtime", get(realtime))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        service: "zca-cloud-server",
    })
}

async fn request_magic_link(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MagicLinkRequest>,
) -> AppResult<Json<MagicLinkResponse>> {
    let email = normalize_email(&req.email)?;
    let rate_window = ChronoDuration::from_std(state.config.magic_link_rate_window)
        .map_err(|_| AppError::BadRequest("invalid magic-link rate window".to_string()))?;
    let rate_since = Utc::now() - rate_window;
    if state.db.count_magic_links_since(&email, rate_since).await?
        >= state.config.magic_link_rate_limit
    {
        let _ = state
            .db
            .insert_audit_event(
                None,
                None,
                "magic_link_rate_limited",
                None,
                serde_json::json!({
                    "emailDomain": email.split('@').nth(1).unwrap_or("unknown")
                }),
            )
            .await;
        return Err(AppError::RateLimited(
            "too many magic-link requests".to_string(),
        ));
    }
    let token = crypto::random_token(32);
    let expires_at = Utc::now()
        + ChronoDuration::from_std(state.config.magic_link_ttl)
            .map_err(|_| AppError::BadRequest("invalid magic-link ttl".to_string()))?;
    state
        .db
        .insert_magic_link(&email, &crypto::token_hash(&token), expires_at)
        .await?;
    crate::mailer::deliver_magic_link(&state.config, &email, &token).await?;
    let _ = state
        .db
        .insert_audit_event(
            None,
            None,
            "magic_link_requested",
            None,
            serde_json::json!({
                "emailDomain": email.split('@').nth(1).unwrap_or("unknown"),
                "deliveryConfigured": state.config.magic_link_webhook_url.is_some()
            }),
        )
        .await;
    tracing::info!(
        email_domain = email.split('@').nth(1).unwrap_or("unknown"),
        "magic link created"
    );
    Ok(Json(MagicLinkResponse {
        sent: true,
        expires_in_secs: state.config.magic_link_ttl.as_secs(),
        dev_magic_token: state.config.dev_return_magic_tokens.then_some(token),
    }))
}

async fn verify_magic_link(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MagicLinkVerifyRequest>,
) -> AppResult<Json<MagicLinkVerifyResponse>> {
    let email = normalize_email(&req.email)?;
    let device_name = validate_device_name(&req.device_name)?;
    let token_hash = crypto::token_hash(&req.token);
    if !state.db.magic_link_is_valid(&email, &token_hash).await? {
        let _ = state
            .db
            .insert_audit_event(
                None,
                None,
                "magic_link_verify_failed",
                None,
                serde_json::json!({
                    "emailDomain": email.split('@').nth(1).unwrap_or("unknown")
                }),
            )
            .await;
        return Err(AppError::Unauthorized);
    }

    let recovery_key = format!("zca-recovery-{}", crypto::random_token(32));
    let data_key = crypto::generate_data_key();
    let (wrap_nonce, wrapped) = crypto::wrap_data_key(&recovery_key, &data_key)?;
    let (server_key_nonce, server_wrapped_data_key) =
        crypto::wrap_data_key_for_server(&state.config.master_key_seed, &data_key)?;
    let mut wrapped_data_key = wrap_nonce;
    wrapped_data_key.extend_from_slice(&wrapped);

    let (user_id, created) = state
        .db
        .get_or_create_user(
            &email,
            &recovery_key,
            &wrapped_data_key,
            &server_key_nonce,
            &server_wrapped_data_key,
        )
        .await?;
    if !created {
        let Some(provided_recovery_key) = req.recovery_key.as_deref() else {
            let _ = state
                .db
                .insert_audit_event(
                    Some(user_id),
                    None,
                    "device_recovery_key_required",
                    None,
                    serde_json::json!({ "deviceName": device_name }),
                )
                .await;
            return Err(AppError::Forbidden);
        };
        let secrets = state.db.user_secrets(user_id).await?;
        if !crypto::verify_recovery_key(&secrets.recovery_key_hash, provided_recovery_key) {
            let _ = state
                .db
                .insert_audit_event(
                    Some(user_id),
                    None,
                    "device_recovery_key_failed",
                    None,
                    serde_json::json!({ "deviceName": device_name }),
                )
                .await;
            return Err(AppError::Forbidden);
        }
    }
    state.db.consume_magic_link(&email, &token_hash).await?;
    let device_token = crypto::random_token(32);
    let device_id = state
        .db
        .insert_device(user_id, device_name, &crypto::token_hash(&device_token))
        .await?;
    let _ = state
        .db
        .insert_audit_event(
            Some(user_id),
            Some(device_id),
            "magic_link_verified_device_registered",
            Some(&device_id.to_string()),
            serde_json::json!({ "createdUser": created, "deviceName": device_name }),
        )
        .await;
    Ok(Json(MagicLinkVerifyResponse {
        user_id,
        device_id,
        device_token,
        recovery_key: created.then_some(recovery_key),
    }))
}

async fn register_device(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Json(req): Json<DeviceRegisterRequest>,
) -> AppResult<Json<DeviceRegisterResponse>> {
    let name = validate_device_name(&req.name)?;
    let secrets = state.db.user_secrets(auth.user_id).await?;
    if !crypto::verify_recovery_key(&secrets.recovery_key_hash, &req.recovery_key) {
        let _ = state
            .db
            .insert_audit_event(
                Some(auth.user_id),
                Some(auth.device_id),
                "device_register_recovery_key_failed",
                None,
                serde_json::json!({ "deviceName": name }),
            )
            .await;
        return Err(AppError::Forbidden);
    }
    let device_token = crypto::random_token(32);
    let device_id = state
        .db
        .insert_device(secrets.user_id, name, &crypto::token_hash(&device_token))
        .await?;
    let _ = state
        .db
        .insert_audit_event(
            Some(secrets.user_id),
            Some(device_id),
            "device_registered",
            Some(&device_id.to_string()),
            serde_json::json!({ "deviceName": name, "registeredByDeviceId": auth.device_id }),
        )
        .await;
    Ok(Json(DeviceRegisterResponse {
        device_id,
        device_token,
    }))
}

async fn list_devices(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
) -> AppResult<Json<Vec<DeviceView>>> {
    Ok(Json(state.db.list_devices(auth.user_id).await?))
}

async fn revoke_device(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(device_id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    state.db.revoke_device(auth.user_id, device_id).await?;
    let _ = state
        .db
        .insert_audit_event(
            Some(auth.user_id),
            Some(auth.device_id),
            "device_revoked",
            Some(&device_id.to_string()),
            serde_json::json!({ "revokedDeviceId": device_id }),
        )
        .await;
    Ok(Json(serde_json::json!({ "revoked": true })))
}

async fn list_accounts(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
) -> AppResult<Json<Vec<AccountView>>> {
    Ok(Json(state.db.list_accounts(auth.user_id).await?))
}

async fn start_account_qr(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
) -> AppResult<Json<QrStartResponse>> {
    let flow_id = state
        .sessions
        .begin_qr_flow(
            auth.user_id,
            state.db.clone(),
            state.config.clone(),
            state.objects.clone(),
            state.events.clone(),
        )
        .await;
    Ok(Json(QrStartResponse {
        flow_id,
        state: "starting".to_string(),
    }))
}

async fn qr_status(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(flow_id): Path<Uuid>,
) -> AppResult<Json<QrFlowStatus>> {
    let flow = state
        .sessions
        .qr_status(flow_id)
        .await
        .ok_or(AppError::NotFound)?;
    if flow.user_id != auth.user_id {
        return Err(AppError::NotFound);
    }
    Ok(Json(flow))
}

async fn account_status(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
) -> AppResult<Json<AccountView>> {
    Ok(Json(
        state.db.account_status(auth.user_id, account_id).await?,
    ))
}

async fn delete_account(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    state.db.delete_account(auth.user_id, account_id).await?;
    let _ = state.sessions.stop(account_id).await;
    Ok(Json(serde_json::json!({ "deleted": true })))
}

async fn send_text(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
    Json(req): Json<SendTextRequest>,
) -> AppResult<Json<SendTextResponse>> {
    if req.thread_id.trim().is_empty() || req.text.trim().is_empty() {
        return Err(AppError::BadRequest(
            "thread_id and text are required".to_string(),
        ));
    }
    let kind = validate_thread_kind(req.thread_kind.as_deref())?;
    state.db.account_status(auth.user_id, account_id).await?;
    let msg_id = state
        .sessions
        .send_text(account_id, &req.thread_id, &req.text, kind)
        .await?;
    Ok(Json(SendTextResponse {
        queued: false,
        msg_id: Some(msg_id),
        reason: None,
    }))
}

async fn resolve_phone(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
    Json(req): Json<ResolvePhoneRequest>,
) -> AppResult<Json<ResolvePhoneResponse>> {
    let phone = validate_phone(&req.phone)?;
    state.db.account_status(auth.user_id, account_id).await?;
    let profile = state.sessions.resolve_phone(account_id, &phone).await?;
    Ok(Json(ResolvePhoneResponse {
        uid: profile.account_id,
        display_name: profile.display_name,
        avatar: profile.avatar,
    }))
}

fn validate_phone(phone: &str) -> AppResult<String> {
    let normalized: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if !(9..=15).contains(&normalized.len()) {
        return Err(AppError::BadRequest(
            "phone must contain 9 to 15 digits".to_string(),
        ));
    }
    Ok(normalized)
}

async fn send_sticker(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
    Json(req): Json<SendStickerRequest>,
) -> AppResult<Json<SendTextResponse>> {
    if req.thread_id.trim().is_empty() || req.sticker_id == 0 || req.sticker_type == 0 {
        return Err(AppError::BadRequest(
            "thread_id, sticker_id, and sticker_type are required".to_string(),
        ));
    }
    let kind = validate_thread_kind(req.thread_kind.as_deref())?;
    state.db.account_status(auth.user_id, account_id).await?;
    let msg_id = state
        .sessions
        .send_sticker(
            account_id,
            &req.thread_id,
            req.sticker_id,
            req.cat_id,
            req.sticker_type,
            kind,
        )
        .await?;
    Ok(Json(SendTextResponse {
        queued: false,
        msg_id: Some(msg_id),
        reason: None,
    }))
}

async fn send_reaction(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
    Json(req): Json<SendReactionRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if req.thread_id.trim().is_empty()
        || req.msg_id.trim().is_empty()
        || req.cli_msg_id.trim().is_empty()
    {
        return Err(AppError::BadRequest(
            "thread_id, msg_id, and cli_msg_id are required".to_string(),
        ));
    }
    let kind = validate_thread_kind(req.thread_kind.as_deref())?;
    state.db.account_status(auth.user_id, account_id).await?;
    state
        .sessions
        .send_reaction(
            account_id,
            &req.icon,
            &req.msg_id,
            &req.cli_msg_id,
            &req.thread_id,
            kind,
        )
        .await?;
    Ok(Json(serde_json::json!({ "sent": true })))
}

async fn send_file(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(account_id): Path<Uuid>,
    Json(req): Json<SendFileRequest>,
) -> AppResult<Json<SendFileResponse>> {
    if req.thread_id.trim().is_empty() {
        return Err(AppError::BadRequest("thread_id is required".to_string()));
    }
    let kind = validate_thread_kind(req.thread_kind.as_deref())?;
    let account = state.db.account_status(auth.user_id, account_id).await?;
    let secret = state.db.file_secret(auth.user_id, req.file_id).await?;
    if secret.account_id != Some(account_id) {
        return Err(AppError::NotFound);
    }

    let filename = secret
        .filename
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("attachment-{}", req.file_id));
    let plaintext = decrypt_file_blob(&state, auth.user_id, &secret).await?;
    if plaintext.len() as i64 != secret.size_bytes
        || sha256_hex(&plaintext) != secret.content_sha256
    {
        return Err(AppError::BadRequest(
            "stored file blob does not match metadata".to_string(),
        ));
    }

    let mut sent = state
        .sessions
        .send_file(
            account_id,
            &req.thread_id,
            &filename,
            secret.mime.as_deref(),
            plaintext,
            kind,
        )
        .await?;
    sent.file.id = Some(req.file_id.to_string());
    sent.file.filename = sent.file.filename.or_else(|| Some(filename.clone()));
    sent.file.mime = sent.file.mime.or_else(|| secret.mime.clone());
    if sent.file.size_bytes <= 0 {
        sent.file.size_bytes = secret.size_bytes;
    }

    let msg_id = sent
        .msg_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("cloud-file-{}", req.file_id));
    persist_outgoing_file_message(
        &state,
        OutgoingFileMessage {
            user_id: auth.user_id,
            account_id,
            account: &account,
            thread_id: &req.thread_id,
            kind,
            msg_id: &msg_id,
            body: &filename,
            file: &sent.file,
        },
    )
    .await?;
    let _ = state.events.send(RealtimeEvent {
        user_id: auth.user_id,
        data: serde_json::json!({
            "type": "message",
            "event": "file",
            "accountId": account_id,
            "threadId": req.thread_id,
            "msgId": msg_id,
            "outgoing": true
        })
        .to_string(),
    });

    Ok(Json(SendFileResponse {
        queued: false,
        msg_id: Some(msg_id),
        reason: None,
        file: sent.file,
    }))
}

fn validate_thread_kind(kind: Option<&str>) -> AppResult<&'static str> {
    match kind.unwrap_or("user") {
        "user" => Ok("user"),
        "group" => Ok("group"),
        _ => Err(AppError::BadRequest(
            "thread_kind must be user or group".to_string(),
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationQuery {
    account_id: Option<Uuid>,
}

async fn list_conversations(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Query(query): Query<ConversationQuery>,
) -> AppResult<Json<Vec<ConversationView>>> {
    let mut rows = state
        .db
        .list_conversations(auth.user_id, query.account_id)
        .await?;
    if let Some(account_id) = query.account_id {
        let mut refreshed = false;
        for row in rows.iter().filter(|row| row.avatar.is_none()) {
            if let Ok(metadata) = state
                .sessions
                .thread_metadata(account_id, &row.thread_id, &row.kind)
                .await
            {
                if metadata.title.is_some() || metadata.avatar.is_some() {
                    state
                        .db
                        .update_conversation_metadata(
                            auth.user_id,
                            account_id,
                            &row.thread_id,
                            metadata.title.as_deref(),
                            metadata.avatar.as_deref(),
                        )
                        .await?;
                    refreshed = true;
                }
            }
        }
        if refreshed {
            rows = state
                .db
                .list_conversations(auth.user_id, query.account_id)
                .await?;
        }
    }
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct MessagesQuery {
    limit: Option<i64>,
}

async fn list_messages(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<MessagesQuery>,
) -> AppResult<Json<Vec<MessageView>>> {
    let rows = state
        .db
        .list_messages(auth.user_id, conversation_id, query.limit.unwrap_or(100))
        .await?;
    let user_secrets = state.db.user_secrets(auth.user_id).await?;
    let data_key = crypto::unwrap_data_key_for_server(
        &state.config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )?;
    let mut messages = Vec::with_capacity(rows.len());
    for row in rows {
        let body = match (row.enc_body.as_deref(), row.body_nonce.as_deref()) {
            (Some(ciphertext), Some(nonce)) => {
                let plaintext = crypto::open(&data_key, nonce, ciphertext)?;
                Some(String::from_utf8(plaintext).map_err(|_| AppError::Crypto)?)
            }
            _ => None,
        };
        let rich = match (row.enc_rich.as_deref(), row.rich_nonce.as_deref()) {
            (Some(ciphertext), Some(nonce)) => {
                let plaintext = crypto::open(&data_key, nonce, ciphertext)?;
                Some(
                    serde_json::from_slice::<crate::models::MessageRichPayload>(&plaintext)
                        .map_err(|_| AppError::Crypto)?,
                )
            }
            _ => None,
        };
        let mut from_avatar = row.from_avatar;
        if from_avatar.is_none() && !row.outgoing {
            if let Some(from_id) = row.from_id.as_deref().filter(|id| !id.trim().is_empty()) {
                if let Ok(metadata) = state
                    .sessions
                    .thread_metadata(row.account_id, from_id, "user")
                    .await
                {
                    if let Some(avatar) = metadata.avatar {
                        state
                            .db
                            .update_message_sender_avatar(
                                auth.user_id,
                                row.account_id,
                                &row.msg_id,
                                &avatar,
                            )
                            .await?;
                        from_avatar = Some(avatar);
                    }
                }
            }
        }

        messages.push(MessageView {
            id: row.id,
            conversation_id: row.conversation_id,
            msg_id: row.msg_id,
            from_id: row.from_id,
            from_name: row.from_name,
            from_avatar,
            body,
            outgoing: row.outgoing,
            kind: row.kind,
            observed_at: row.observed_at,
            deleted: row.deleted,
            sticker: rich.as_ref().and_then(|r| r.sticker.clone()),
            quote: rich.as_ref().and_then(|r| r.quote.clone()),
            link: rich.as_ref().and_then(|r| r.link.clone()),
            file: rich.as_ref().and_then(|r| r.file.clone()),
            reaction_icon: rich.as_ref().and_then(|r| r.reaction_icon.clone()),
            raw: rich.as_ref().and_then(|r| r.raw.clone()),
        });
    }
    Ok(Json(messages))
}

async fn init_file(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Json(req): Json<FileInitRequest>,
) -> AppResult<Json<FileView>> {
    if req.size_bytes < 0 || !is_lower_hex_sha256(&req.content_sha256) {
        return Err(AppError::BadRequest(
            "valid size_bytes and content_sha256 are required".to_string(),
        ));
    }
    let file_id = Uuid::new_v4();
    let object_key = crate::storage::object_key(auth.user_id, file_id, &req.content_sha256);
    let user_secrets = state.db.user_secrets(auth.user_id).await?;
    let data_key = crypto::unwrap_data_key_for_server(
        &state.config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )?;
    let file_key = crypto::generate_data_key();
    let (nonce, enc_file_key) = crypto::seal(&data_key, &file_key)?;
    let view = state
        .db
        .insert_file(auth.user_id, &req, &object_key, &enc_file_key, &nonce)
        .await?;
    Ok(Json(view))
}

async fn get_file(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(file_id): Path<Uuid>,
) -> AppResult<Json<FileView>> {
    Ok(Json(state.db.get_file(auth.user_id, file_id).await?))
}

async fn upload_file_blob(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(file_id): Path<Uuid>,
    body: Bytes,
) -> AppResult<Json<serde_json::Value>> {
    let secret = state.db.file_secret(auth.user_id, file_id).await?;
    if body.len() as i64 != secret.size_bytes {
        return Err(AppError::BadRequest(
            "file size does not match metadata".to_string(),
        ));
    }
    if sha256_hex(&body) != secret.content_sha256 {
        return Err(AppError::BadRequest(
            "file content_sha256 does not match metadata".to_string(),
        ));
    }
    let user_secrets = state.db.user_secrets(auth.user_id).await?;
    let data_key = crypto::unwrap_data_key_for_server(
        &state.config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )?;
    let file_key = crypto::open(&data_key, &secret.file_key_nonce, &secret.enc_file_key)?;
    let file_key: [u8; 32] = file_key
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Crypto)?;
    let (nonce, ciphertext) = crypto::seal(&file_key, &body)?;
    let mut object_body = nonce;
    object_body.extend_from_slice(&ciphertext);
    state
        .objects
        .put(
            &object_store::path::Path::from(secret.object_key),
            object_body.into(),
        )
        .await
        .map_err(|e| AppError::BadRequest(format!("object upload failed: {e}")))?;
    Ok(Json(
        serde_json::json!({ "uploaded": true, "ciphertextBytes": object_body_len(body.len()) }),
    ))
}

async fn download_file_blob(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
    Path(file_id): Path<Uuid>,
) -> AppResult<impl IntoResponse> {
    let secret = state.db.file_secret(auth.user_id, file_id).await?;
    let plaintext = decrypt_file_blob(&state, auth.user_id, &secret).await?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok((StatusCode::OK, headers, plaintext))
}

async fn decrypt_file_blob(
    state: &AppState,
    user_id: Uuid,
    secret: &crate::db::FileSecret,
) -> AppResult<Vec<u8>> {
    let user_secrets = state.db.user_secrets(user_id).await?;
    let data_key = crypto::unwrap_data_key_for_server(
        &state.config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )?;
    let file_key = crypto::open(&data_key, &secret.file_key_nonce, &secret.enc_file_key)?;
    let file_key: [u8; 32] = file_key
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Crypto)?;
    let object = state
        .objects
        .get(&object_store::path::Path::from(secret.object_key.clone()))
        .await
        .map_err(|_| AppError::NotFound)?
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("object download failed: {e}")))?;
    if object.len() < 12 {
        return Err(AppError::Crypto);
    }
    let (nonce, ciphertext) = object.split_at(12);
    crypto::open(&file_key, nonce, ciphertext)
}

async fn data_key_for_user(state: &AppState, user_id: Uuid) -> AppResult<[u8; 32]> {
    let user_secrets = state.db.user_secrets(user_id).await?;
    crypto::unwrap_data_key_for_server(
        &state.config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )
}

fn encrypt_optional(
    data_key: &[u8; 32],
    plaintext: Option<&[u8]>,
) -> AppResult<OptionalCiphertext> {
    let Some(plaintext) = plaintext else {
        return Ok((None, None));
    };
    let (nonce, ciphertext) = crypto::seal(data_key, plaintext)?;
    Ok((Some(nonce), Some(ciphertext)))
}

async fn persist_outgoing_file_message(
    state: &AppState,
    message: OutgoingFileMessage<'_>,
) -> AppResult<()> {
    let data_key = data_key_for_user(state, message.user_id).await?;
    let (body_nonce, enc_body) = encrypt_optional(&data_key, Some(message.body.as_bytes()))?;
    let rich = MessageRichPayload {
        file: Some(message.file.clone()),
        ..MessageRichPayload::default()
    };
    let rich_json = serde_json::to_vec(&rich).map_err(|_| AppError::Crypto)?;
    let (rich_nonce, enc_rich) = encrypt_optional(&data_key, Some(&rich_json))?;
    let metadata = state
        .sessions
        .thread_metadata(message.account_id, message.thread_id, message.kind)
        .await
        .unwrap_or_default();
    let conversation_id = state
        .db
        .upsert_conversation(
            message.user_id,
            message.account_id,
            message.thread_id,
            message.kind,
            metadata.title.as_deref(),
            metadata.avatar.as_deref(),
        )
        .await?;
    state
        .db
        .insert_message_ciphertext(
            message.user_id,
            message.account_id,
            conversation_id,
            message.msg_id,
            Some(&message.account.zalo_account_id),
            message.account.display_name.as_deref(),
            message.account.avatar.as_deref(),
            enc_body.as_deref(),
            body_nonce.as_deref(),
            enc_rich.as_deref(),
            rich_nonce.as_deref(),
            true,
            "file",
            None,
        )
        .await?;
    Ok(())
}

fn object_body_len(plaintext_len: usize) -> usize {
    plaintext_len + 12 + 16
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

async fn realtime(
    State(state): State<Arc<AppState>>,
    Auth(auth): Auth,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(move |item| match item {
        Ok(event) => realtime_payload_for_user(auth.user_id, event)
            .map(|data| Ok(Event::default().event("message").data(data))),
        Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => {
            Some(Ok(Event::default().event("lagged").data("{}")))
        }
    });
    Sse::new(stream)
}

fn realtime_payload_for_user(user_id: Uuid, event: RealtimeEvent) -> Option<String> {
    (event.user_id == user_id).then_some(event.data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn realtime_payload_is_user_scoped() {
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let event = RealtimeEvent {
            user_id: owner,
            data: serde_json::json!({ "type": "message" }).to_string(),
        };
        assert!(realtime_payload_for_user(owner, event.clone()).is_some());
        assert!(realtime_payload_for_user(other, event).is_none());
    }

    #[test]
    fn file_sha256_validation_requires_lower_hex() {
        assert!(is_lower_hex_sha256(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_lower_hex_sha256(
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
        ));
        assert!(!is_lower_hex_sha256("not-a-sha"));
    }
}
