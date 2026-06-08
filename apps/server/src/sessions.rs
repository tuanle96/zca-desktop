use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use object_store::ObjectStore;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::models::{FileInitRequest, MessageRichPayload, QrFlowStatus, RealtimeEvent, RichFile};
use crate::zalo_host::{
    HostedCredentials, HostedIncomingMessage, HostedQrEvent, HostedRealtimeEvent,
    HostedUploadCallbacks,
};

type RichCiphertext = (Option<Vec<u8>>, Option<Vec<u8>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedSessionState {
    Starting,
    Online,
    ReauthNeeded,
    Stopped,
}

#[derive(Clone)]
pub struct HostedSession {
    pub account_id: Uuid,
    pub state: HostedSessionState,
    api: Arc<zca_rust::API>,
    listener: Arc<Mutex<zca_rust::listen::Listener>>,
}

#[derive(Debug)]
pub struct SendThrottle {
    interval: Duration,
    next_allowed: Mutex<HashMap<Uuid, Instant>>,
}

impl SendThrottle {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            next_allowed: Mutex::new(HashMap::new()),
        }
    }

    pub async fn reserve(&self, account_id: Uuid, now: Instant) -> Duration {
        let mut map = self.next_allowed.lock().await;
        let scheduled = map.get(&account_id).copied().unwrap_or(now).max(now);
        map.insert(account_id, scheduled + self.interval);
        scheduled.saturating_duration_since(now)
    }
}

pub struct HostedSessionManager {
    sessions: Arc<Mutex<HashMap<Uuid, HostedSession>>>,
    qr_flows: Arc<Mutex<HashMap<Uuid, QrFlowStatus>>>,
    upload_file_urls: Arc<Mutex<HashMap<String, String>>>,
    throttle: SendThrottle,
}

struct HostedRealtimeContext<'a> {
    db: &'a crate::Db,
    config: &'a crate::Config,
    objects: Arc<dyn ObjectStore>,
    api: &'a zca_rust::apis::API,
    events: &'a tokio::sync::broadcast::Sender<RealtimeEvent>,
    user_id: Uuid,
    account_id: Uuid,
    source: &'a str,
    upload_file_urls: Arc<Mutex<HashMap<String, String>>>,
}

struct QrFlowContext {
    flow_id: Uuid,
    user_id: Uuid,
    db: crate::Db,
    config: crate::Config,
    objects: Arc<dyn ObjectStore>,
    events: tokio::sync::broadcast::Sender<RealtimeEvent>,
    qr_flows: Arc<Mutex<HashMap<Uuid, QrFlowStatus>>>,
    sessions: HostedSessionTaskHandle,
}

struct MediaMirrorContext<'a> {
    db: &'a crate::Db,
    config: &'a crate::Config,
    objects: Arc<dyn ObjectStore>,
    user_id: Uuid,
    account_id: Uuid,
    conversation_id: Uuid,
    message_id: Uuid,
    data_key: &'a [u8; 32],
}

impl Default for HostedSessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            qr_flows: Arc::new(Mutex::new(HashMap::new())),
            upload_file_urls: Arc::new(Mutex::new(HashMap::new())),
            throttle: SendThrottle::new(Duration::from_millis(800)),
        }
    }
}

impl HostedSessionManager {
    pub async fn upsert_session(
        &self,
        account_id: Uuid,
        state: HostedSessionState,
        api: Arc<zca_rust::API>,
        listener: zca_rust::listen::Listener,
    ) {
        self.sessions.lock().await.insert(
            account_id,
            HostedSession {
                account_id,
                state,
                api,
                listener: Arc::new(Mutex::new(listener)),
            },
        );
    }

    pub async fn state(&self, account_id: Uuid) -> Option<HostedSessionState> {
        self.sessions.lock().await.get(&account_id).map(|s| s.state)
    }

    pub async fn reserve_send(&self, account_id: Uuid) -> Duration {
        self.throttle.reserve(account_id, Instant::now()).await
    }

    pub async fn send_text(
        &self,
        account_id: Uuid,
        thread_id: &str,
        text: &str,
        kind: &str,
    ) -> AppResult<String> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        let wait = self.reserve_send(account_id).await;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        crate::zalo_host::send_text(&api, thread_id, text, kind)
            .await
            .map_err(|e| AppError::BadRequest(format!("hosted send failed: {e}")))
    }

    pub async fn resolve_phone(
        &self,
        account_id: Uuid,
        phone: &str,
    ) -> AppResult<crate::zalo_host::HostedProfile> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        crate::zalo_host::resolve_phone(&api, phone)
            .await
            .map_err(|e| AppError::BadRequest(format!("hosted phone resolve failed: {e}")))
    }

    pub async fn list_contacts(
        &self,
        account_id: Uuid,
    ) -> AppResult<Vec<crate::models::ContactView>> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        crate::zalo_host::list_contacts(&api)
            .await
            .map_err(|e| AppError::BadRequest(format!("hosted contacts load failed: {e}")))
    }

    pub async fn thread_metadata(
        &self,
        account_id: Uuid,
        thread_id: &str,
        kind: &str,
    ) -> AppResult<crate::zalo_host::HostedThreadMetadata> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        crate::zalo_host::thread_metadata(&api, thread_id, kind)
            .await
            .map_err(|e| AppError::BadRequest(format!("hosted thread metadata failed: {e}")))
    }

    pub async fn send_sticker(
        &self,
        account_id: Uuid,
        thread_id: &str,
        sticker_id: i64,
        cat_id: i64,
        sticker_type: i64,
        kind: &str,
    ) -> AppResult<String> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        let wait = self.reserve_send(account_id).await;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        crate::zalo_host::send_sticker(&api, thread_id, sticker_id, cat_id, sticker_type, kind)
            .await
            .map_err(|e| AppError::BadRequest(format!("hosted sticker send failed: {e}")))
    }

    pub async fn send_file(
        &self,
        account_id: Uuid,
        thread_id: &str,
        filename: &str,
        mime: Option<&str>,
        bytes: Vec<u8>,
        kind: &str,
    ) -> AppResult<crate::zalo_host::HostedAttachmentSend> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        let wait = self.reserve_send(account_id).await;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        crate::zalo_host::send_file(
            &api,
            thread_id,
            filename,
            mime,
            bytes,
            kind,
            Some(HostedUploadCallbacks {
                file_urls: self.upload_file_urls.clone(),
                key_prefix: account_id.to_string(),
            }),
        )
        .await
        .map_err(|e| AppError::BadRequest(format!("hosted file send failed: {e}")))
    }

    pub async fn send_reaction(
        &self,
        account_id: Uuid,
        icon: &str,
        msg_id: &str,
        cli_msg_id: &str,
        thread_id: &str,
        kind: &str,
    ) -> AppResult<()> {
        let api = {
            let sessions = self.sessions.lock().await;
            sessions
                .get(&account_id)
                .map(|s| s.api.clone())
                .ok_or(AppError::NotFound)?
        };
        crate::zalo_host::send_reaction(&api, icon, msg_id, cli_msg_id, thread_id, kind)
            .await
            .map_err(|e| AppError::BadRequest(format!("hosted reaction send failed: {e}")))
    }

    pub async fn stop(&self, account_id: Uuid) -> bool {
        let session = self.sessions.lock().await.remove(&account_id);
        if let Some(session) = session {
            session.listener.lock().await.stop();
            true
        } else {
            false
        }
    }

    pub async fn qr_status(&self, flow_id: Uuid) -> Option<QrFlowStatus> {
        self.qr_flows.lock().await.get(&flow_id).cloned()
    }

    pub async fn begin_qr_flow(
        &self,
        user_id: Uuid,
        db: crate::Db,
        config: crate::Config,
        objects: Arc<dyn ObjectStore>,
        events: tokio::sync::broadcast::Sender<RealtimeEvent>,
    ) -> Uuid {
        let flow_id = Uuid::new_v4();
        self.qr_flows.lock().await.insert(
            flow_id,
            QrFlowStatus {
                user_id,
                flow_id,
                state: "starting".to_string(),
                qr_image: None,
                display_name: None,
                avatar: None,
                account_id: None,
                error: None,
            },
        );

        let qr_flows = self.qr_flows.clone();
        let sessions = self.clone_for_task();
        tokio::spawn(async move {
            let ctx = QrFlowContext {
                flow_id,
                user_id,
                db,
                config,
                objects,
                events,
                qr_flows,
                sessions,
            };
            if let Err(e) = run_qr_flow(ctx).await {
                tracing::warn!(flow_id = %flow_id, error = %e, "hosted QR flow failed");
            }
        });
        flow_id
    }

    pub async fn restore_active_sessions(
        &self,
        db: crate::Db,
        config: crate::Config,
        objects: Arc<dyn ObjectStore>,
        events: tokio::sync::broadcast::Sender<RealtimeEvent>,
    ) -> AppResult<usize> {
        let accounts = db.active_account_credentials().await?;
        let mut restored = 0usize;
        for account in accounts {
            let account_id = account.id;
            match restore_one_account(
                self.sessions.clone(),
                self.upload_file_urls.clone(),
                db.clone(),
                config.clone(),
                objects.clone(),
                events.clone(),
                account,
            )
            .await
            {
                Ok(()) => restored += 1,
                Err(e) => {
                    tracing::warn!(account_id = %account_id, error = %e, "failed to restore hosted account");
                    let _ = db
                        .set_account_state(account_id, "reauth-needed", Some(&e.to_string()))
                        .await;
                }
            }
        }
        Ok(restored)
    }

    fn clone_for_task(&self) -> HostedSessionTaskHandle {
        HostedSessionTaskHandle {
            sessions: self.sessions.clone(),
            upload_file_urls: self.upload_file_urls.clone(),
        }
    }
}

async fn restore_one_account(
    sessions: Arc<Mutex<HashMap<Uuid, HostedSession>>>,
    upload_file_urls: Arc<Mutex<HashMap<String, String>>>,
    db: crate::Db,
    config: crate::Config,
    objects: Arc<dyn ObjectStore>,
    events: tokio::sync::broadcast::Sender<RealtimeEvent>,
    account: crate::db::AccountCredential,
) -> AppResult<()> {
    let user_secrets = db.user_secrets(account.user_id).await?;
    let data_key = crypto::unwrap_data_key_for_server(
        &config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )?;
    let plaintext = crypto::open(
        &data_key,
        &account.credentials_nonce,
        &account.enc_credentials,
    )?;
    let credentials: HostedCredentials =
        serde_json::from_slice(&plaintext).map_err(|_| AppError::Crypto)?;
    let api = Arc::new(
        crate::zalo_host::login(credentials, true)
            .await
            .map_err(|e| AppError::BadRequest(format!("restore login failed: {e}")))?,
    );
    let (message_tx, mut message_rx) = tokio::sync::mpsc::channel::<HostedRealtimeEvent>(256);
    let listener = crate::zalo_host::start_message_listener(api.clone(), message_tx)
        .await
        .map_err(|e| AppError::BadRequest(format!("restore listener failed: {e}")))?;
    db.mark_account_active(account.id, None).await?;
    sessions.lock().await.insert(
        account.id,
        HostedSession {
            account_id: account.id,
            state: HostedSessionState::Online,
            api: api.clone(),
            listener: Arc::new(Mutex::new(listener)),
        },
    );
    tokio::spawn(async move {
        while let Some(event) = message_rx.recv().await {
            let ctx = HostedRealtimeContext {
                db: &db,
                config: &config,
                objects: objects.clone(),
                api: api.as_ref(),
                events: &events,
                user_id: account.user_id,
                account_id: account.id,
                source: "restored",
                upload_file_urls: upload_file_urls.clone(),
            };
            handle_hosted_realtime_event(&ctx, event).await;
        }
    });
    Ok(())
}

struct HostedSessionTaskHandle {
    sessions: Arc<Mutex<HashMap<Uuid, HostedSession>>>,
    upload_file_urls: Arc<Mutex<HashMap<String, String>>>,
}

async fn run_qr_flow(ctx: QrFlowContext) -> AppResult<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<HostedQrEvent>(16);
    let flow_id = ctx.flow_id;
    let user_id = ctx.user_id;
    let flow_updates = ctx.qr_flows.clone();
    let db = ctx.db;
    let config = ctx.config;
    let objects = ctx.objects;
    let events = ctx.events;
    let qr_flows = ctx.qr_flows;
    let sessions = ctx.sessions;
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let mut flows = flow_updates.lock().await;
            let Some(flow) = flows.get_mut(&flow_id) else {
                continue;
            };
            match event {
                HostedQrEvent::Generated { image } => {
                    flow.state = "waiting-scan".to_string();
                    flow.qr_image = Some(image);
                }
                HostedQrEvent::Scanned {
                    display_name,
                    avatar,
                } => {
                    flow.state = "scanned".to_string();
                    flow.display_name = Some(display_name);
                    flow.avatar = Some(avatar);
                }
                HostedQrEvent::Declined => flow.state = "declined".to_string(),
                HostedQrEvent::Expired => flow.state = "expired".to_string(),
                HostedQrEvent::Success { profile } => {
                    flow.state = "success".to_string();
                    flow.display_name = profile.display_name;
                    flow.avatar = profile.avatar;
                }
            }
        }
    });

    let (credentials, api, profile) = match crate::zalo_host::run_qr_login(tx).await {
        Ok(ok) => ok,
        Err(e) => {
            let mut flows = qr_flows.lock().await;
            if let Some(flow) = flows.get_mut(&flow_id) {
                flow.state = "error".to_string();
                flow.error = Some(e.to_string());
            }
            return Err(AppError::BadRequest(format!("QR login failed: {e}")));
        }
    };

    // The phone-side event loop above may have already flipped this flow to
    // "success" the instant the scan was approved. Everything below actually
    // *persists* the linked account; if any of it fails (e.g. the server can't
    // unwrap this user's data key because the master key changed), we must roll
    // the flow back to "error" instead of leaving the client polling a fake
    // success with no account it can ever load.
    macro_rules! persist_step {
        ($e:expr) => {
            match $e {
                Ok(v) => v,
                Err(err) => {
                    let detail = err.to_string();
                    let mut flows = qr_flows.lock().await;
                    if let Some(flow) = flows.get_mut(&flow_id) {
                        flow.state = "error".to_string();
                        flow.error = Some("failed to store linked account".to_string());
                    }
                    tracing::warn!(flow_id = %flow_id, user_id = %user_id, error = %detail, "QR scan succeeded but persisting the account failed");
                    return Err(err);
                }
            }
        };
    }

    let user_secrets = persist_step!(db.user_secrets(user_id).await);
    let data_key = persist_step!(crypto::unwrap_data_key_for_server(
        &config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    ));
    let credentials_json =
        persist_step!(serde_json::to_vec(&credentials).map_err(|_| AppError::Crypto));
    let (nonce, ciphertext) = persist_step!(crypto::seal(&data_key, &credentials_json));
    let account = persist_step!(
        db.upsert_account_credentials(
            user_id,
            &profile.account_id,
            profile.display_name.as_deref(),
            profile.avatar.as_deref(),
            &ciphertext,
            &nonce,
        )
        .await
    );
    persist_step!(db.mark_account_active(account.id, None).await);

    let (message_tx, mut message_rx) = tokio::sync::mpsc::channel::<HostedRealtimeEvent>(256);
    let listener_api = Arc::new(api);
    let listener = persist_step!(crate::zalo_host::start_message_listener(
        listener_api.clone(),
        message_tx
    )
    .await
    .map_err(|e| AppError::BadRequest(format!("listener failed: {e}"))));

    sessions.sessions.lock().await.insert(
        account.id,
        HostedSession {
            account_id: account.id,
            state: HostedSessionState::Online,
            api: listener_api.clone(),
            listener: Arc::new(Mutex::new(listener)),
        },
    );
    {
        let mut flows = qr_flows.lock().await;
        if let Some(flow) = flows.get_mut(&flow_id) {
            flow.account_id = Some(account.id);
            flow.state = "success".to_string();
        }
    }

    tokio::spawn(async move {
        while let Some(event) = message_rx.recv().await {
            let ctx = HostedRealtimeContext {
                db: &db,
                config: &config,
                objects: objects.clone(),
                api: listener_api.as_ref(),
                events: &events,
                user_id,
                account_id: account.id,
                source: "qr",
                upload_file_urls: sessions.upload_file_urls.clone(),
            };
            handle_hosted_realtime_event(&ctx, event).await;
        }
    });

    Ok(())
}

async fn handle_hosted_realtime_event(ctx: &HostedRealtimeContext<'_>, event: HostedRealtimeEvent) {
    match event {
        HostedRealtimeEvent::Message(message) => {
            if let Err(e) = persist_hosted_message(
                ctx.db,
                ctx.config,
                ctx.objects.clone(),
                ctx.api,
                ctx.user_id,
                ctx.account_id,
                &message,
            )
            .await
            {
                tracing::warn!(account_id = %ctx.account_id, source = ctx.source, error = %e, "failed to persist hosted message");
            }
            emit_hosted_realtime(
                ctx.events,
                ctx.user_id,
                ctx.account_id,
                "message",
                &message.thread_id,
                &message.msg_id,
                message.outgoing,
            );
        }
        HostedRealtimeEvent::Reaction(reaction) => {
            if let Err(e) =
                persist_hosted_reaction(ctx.db, ctx.config, ctx.user_id, ctx.account_id, &reaction)
                    .await
            {
                tracing::warn!(account_id = %ctx.account_id, source = ctx.source, error = %e, "failed to persist hosted reaction");
            }
            emit_hosted_realtime(
                ctx.events,
                ctx.user_id,
                ctx.account_id,
                "reaction",
                &reaction.thread_id,
                &reaction.msg_id,
                reaction.outgoing,
            );
        }
        HostedRealtimeEvent::Undo(undo) => {
            if let Err(e) = ctx
                .db
                .mark_message_deleted(ctx.user_id, ctx.account_id, &undo.msg_id)
                .await
            {
                tracing::warn!(account_id = %ctx.account_id, source = ctx.source, error = %e, "failed to persist hosted undo");
            }
            emit_hosted_realtime(
                ctx.events,
                ctx.user_id,
                ctx.account_id,
                "undo",
                &undo.thread_id,
                &undo.msg_id,
                undo.outgoing,
            );
        }
        HostedRealtimeEvent::Upload(upload) => {
            if !upload.file_url.trim().is_empty() {
                let file_id = if upload.file_id.trim().is_empty() {
                    "__unknown_file_id__"
                } else {
                    upload.file_id.as_str()
                };
                let key = format!("{}:{file_id}", ctx.account_id);
                ctx.upload_file_urls
                    .lock()
                    .await
                    .insert(key, upload.file_url);
                tracing::info!(
                    account_id = %ctx.account_id,
                    source = ctx.source,
                    has_file_id = !upload.file_id.trim().is_empty(),
                    "stored hosted upload callback"
                );
            } else {
                tracing::warn!(
                    account_id = %ctx.account_id,
                    source = ctx.source,
                    has_file_id = !upload.file_id.trim().is_empty(),
                    has_file_url = !upload.file_url.trim().is_empty(),
                    "ignored incomplete hosted upload callback"
                );
            }
        }
    }
}

fn emit_hosted_realtime(
    events: &tokio::sync::broadcast::Sender<RealtimeEvent>,
    user_id: Uuid,
    account_id: Uuid,
    event_type: &str,
    thread_id: &str,
    msg_id: &str,
    outgoing: bool,
) {
    let _ = events.send(RealtimeEvent {
        user_id,
        data: serde_json::json!({
            "type": "message",
            "event": event_type,
            "accountId": account_id,
            "threadId": thread_id,
            "msgId": msg_id,
            "outgoing": outgoing
        })
        .to_string(),
    });
}

async fn data_key_for_user(
    db: &crate::Db,
    config: &crate::Config,
    user_id: Uuid,
) -> AppResult<[u8; 32]> {
    let user_secrets = db.user_secrets(user_id).await?;
    crypto::unwrap_data_key_for_server(
        &config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )
}

fn encrypted_rich(
    data_key: &[u8; 32],
    rich: Option<&crate::models::MessageRichPayload>,
) -> AppResult<RichCiphertext> {
    let Some(rich) = rich.filter(|payload| !payload.is_empty()) else {
        return Ok((None, None));
    };
    let json = serde_json::to_vec(rich).map_err(|_| AppError::Crypto)?;
    let (nonce, ciphertext) = crypto::seal(data_key, &json)?;
    Ok((Some(nonce), Some(ciphertext)))
}

async fn persist_hosted_reaction(
    db: &crate::Db,
    config: &crate::Config,
    user_id: Uuid,
    account_id: Uuid,
    reaction: &crate::zalo_host::HostedReactionEvent,
) -> AppResult<()> {
    let data_key = data_key_for_user(db, config, user_id).await?;
    let mut rich = match db
        .message_rich_ciphertext(user_id, account_id, &reaction.msg_id)
        .await?
    {
        Some(existing) => match (existing.enc_rich.as_deref(), existing.rich_nonce.as_deref()) {
            (Some(ciphertext), Some(nonce)) => {
                let plaintext = crypto::open(&data_key, nonce, ciphertext)?;
                serde_json::from_slice::<crate::models::MessageRichPayload>(&plaintext)
                    .unwrap_or_default()
            }
            _ => crate::models::MessageRichPayload::default(),
        },
        None => crate::models::MessageRichPayload::default(),
    };
    rich.reaction_icon = Some(reaction.icon.clone());
    let (rich_nonce, enc_rich) = encrypted_rich(&data_key, Some(&rich))?;
    if let (Some(nonce), Some(ciphertext)) = (rich_nonce, enc_rich) {
        let _ = db
            .update_message_rich(user_id, account_id, &reaction.msg_id, &ciphertext, &nonce)
            .await?;
    }
    Ok(())
}

async fn mirror_hosted_media(
    ctx: &MediaMirrorContext<'_>,
    rich: &mut MessageRichPayload,
) -> AppResult<bool> {
    let Some(file) = rich.file.as_mut() else {
        return Ok(false);
    };
    mirror_rich_file(ctx, file).await
}

async fn mirror_rich_file(ctx: &MediaMirrorContext<'_>, file: &mut RichFile) -> AppResult<bool> {
    if file.id.is_some() {
        return Ok(false);
    }
    let Some(href) = file.href.as_deref().filter(|href| !href.trim().is_empty()) else {
        return Ok(false);
    };
    let Some(url) = mirrorable_media_url(href) else {
        return Ok(false);
    };

    let bytes = fetch_remote_media(&url, ctx.config.media_mirror_max_bytes).await?;
    let content_sha256 = sha256_hex(&bytes);
    let file_key = crypto::generate_data_key();
    let (file_key_nonce, enc_file_key) = crypto::seal(ctx.data_key, &file_key)?;
    let file_id_for_key = Uuid::new_v4();
    let object_key = crate::storage::object_key(ctx.user_id, file_id_for_key, &content_sha256);
    let object_body = encrypted_object_body(&file_key, &bytes)?;
    ctx.objects
        .put(
            &object_store::path::Path::from(object_key.clone()),
            object_body.into(),
        )
        .await
        .map_err(|e| AppError::BadRequest(format!("object upload failed: {e}")))?;

    let view = ctx
        .db
        .insert_file(
            ctx.user_id,
            &FileInitRequest {
                account_id: Some(ctx.account_id),
                conversation_id: Some(ctx.conversation_id),
                message_id: Some(ctx.message_id),
                filename: file.filename.clone(),
                mime: file.mime.clone(),
                size_bytes: bytes.len() as i64,
                content_sha256,
            },
            &object_key,
            &enc_file_key,
            &file_key_nonce,
        )
        .await?;
    file.id = Some(view.id.to_string());
    file.size_bytes = view.size_bytes;
    Ok(true)
}

async fn fetch_remote_media(url: &reqwest::Url, max_bytes: usize) -> AppResult<Vec<u8>> {
    // SSRF guard: resolve the target host and reject private / loopback / link-local /
    // CGNAT ranges so an attacker-supplied media URL can't make the server reach
    // internal services (cloud metadata, localhost, intranet). Redirects are disabled
    // so a public URL can't bounce to an internal one.
    ensure_public_host(url).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| AppError::BadRequest(format!("media fetch client failed: {e}")))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("media fetch failed: {e}")))?;
    if !response.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "media fetch failed with status {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err(AppError::BadRequest(
            "media exceeds mirror limit".to_string(),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("media read failed: {e}")))?;
    if bytes.len() > max_bytes {
        return Err(AppError::BadRequest(
            "media exceeds mirror limit".to_string(),
        ));
    }
    Ok(bytes.to_vec())
}

fn mirrorable_media_url(href: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(href).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

/// Reject media URLs whose host resolves to a non-public IP range (SSRF guard).
/// This is a best-effort mitigation: it resolves the host and blocks private ranges
/// before the request, and redirects are disabled by the caller.
async fn ensure_public_host(url: &reqwest::Url) -> AppResult<()> {
    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest("media url has no host".to_string()))?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<std::net::IpAddr> = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| AppError::BadRequest("media host resolution failed".to_string()))?
            .map(|sa| sa.ip())
            .collect(),
    };
    if addrs.is_empty() {
        return Err(AppError::BadRequest(
            "media host did not resolve".to_string(),
        ));
    }
    if addrs.iter().any(is_blocked_ip) {
        return Err(AppError::BadRequest(
            "media host is not allowed".to_string(),
        ));
    }
    Ok(())
}

/// True for IPs that must never be reachable via a user-supplied media URL.
fn is_blocked_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 (CGNAT)
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || v6
                    .to_ipv4_mapped()
                    .map(|v4| is_blocked_ip(&std::net::IpAddr::V4(v4)))
                    .unwrap_or(false)
        }
    }
}

fn encrypted_object_body(file_key: &[u8; 32], bytes: &[u8]) -> AppResult<Vec<u8>> {
    let (nonce, mut ciphertext) = crypto::seal(file_key, bytes)?;
    let mut object_body = nonce;
    object_body.append(&mut ciphertext);
    Ok(object_body)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

async fn persist_hosted_message(
    db: &crate::Db,
    config: &crate::Config,
    objects: Arc<dyn ObjectStore>,
    api: &zca_rust::apis::API,
    user_id: Uuid,
    account_id: Uuid,
    message: &HostedIncomingMessage,
) -> AppResult<()> {
    if message.thread_id.trim().is_empty() {
        tracing::warn!(
            account_id = %account_id,
            msg_id = %message.msg_id,
            "skipping hosted message with empty thread id"
        );
        return Ok(());
    }

    let data_key = data_key_for_user(db, config, user_id).await?;
    let (body_nonce, enc_body) = match message.text.as_deref() {
        Some(text) => {
            let (nonce, ciphertext) = crypto::seal(&data_key, text.as_bytes())?;
            (Some(nonce), Some(ciphertext))
        }
        None => (None, None),
    };
    let mut rich = message.rich.clone();
    let (rich_nonce, enc_rich) = encrypted_rich(&data_key, rich.as_ref())?;
    let metadata = crate::zalo_host::thread_metadata(api, &message.thread_id, message.kind)
        .await
        .unwrap_or_default();
    let sender_metadata = if message.kind == "group" && !message.outgoing {
        if let Some(from_id) = message
            .from_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        {
            crate::zalo_host::thread_metadata(api, from_id, "user")
                .await
                .unwrap_or_default()
        } else {
            crate::zalo_host::HostedThreadMetadata::default()
        }
    } else {
        crate::zalo_host::HostedThreadMetadata::default()
    };
    let conversation_id = db
        .upsert_conversation(
            user_id,
            account_id,
            &message.thread_id,
            message.kind,
            metadata.title.as_deref().or(message.from_name.as_deref()),
            metadata.avatar.as_deref(),
        )
        .await?;
    let stored_message_id = db
        .insert_message_ciphertext(
            user_id,
            account_id,
            conversation_id,
            &message.msg_id,
            message.from_id.as_deref(),
            message.from_name.as_deref(),
            sender_metadata.avatar.as_deref(),
            enc_body.as_deref(),
            body_nonce.as_deref(),
            enc_rich.as_deref(),
            rich_nonce.as_deref(),
            message.outgoing,
            message_kind(message),
            message.timestamp.as_deref(),
        )
        .await?;
    if let Some(rich) = rich.as_mut() {
        let mirror_ctx = MediaMirrorContext {
            db,
            config,
            objects,
            user_id,
            account_id,
            conversation_id,
            message_id: stored_message_id,
            data_key: &data_key,
        };
        let mirrored = match mirror_hosted_media(&mirror_ctx, rich).await {
            Ok(changed) => changed,
            Err(e) => {
                tracing::warn!(
                    account_id = %account_id,
                    msg_id = %message.msg_id,
                    error = %e,
                    "hosted media mirror failed; keeping remote media metadata"
                );
                false
            }
        };
        if mirrored {
            let (rich_nonce, enc_rich) = encrypted_rich(&data_key, Some(rich))?;
            if let (Some(nonce), Some(ciphertext)) = (rich_nonce, enc_rich) {
                let _ = db
                    .update_message_rich(user_id, account_id, &message.msg_id, &ciphertext, &nonce)
                    .await?;
            }
        }
    }
    Ok(())
}

fn message_kind(message: &HostedIncomingMessage) -> &'static str {
    if let Some(rich) = message.rich.as_ref() {
        if rich.sticker.is_some() {
            return "sticker";
        }
        if rich.link.is_some() {
            return "link";
        }
        if rich.file.is_some() {
            return "file";
        }
    }
    "text"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn throttle_is_per_account() {
        let throttle = SendThrottle::new(Duration::from_millis(800));
        let now = Instant::now();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        assert_eq!(throttle.reserve(a, now).await, Duration::ZERO);
        assert_eq!(throttle.reserve(a, now).await, Duration::from_millis(800));
        assert_eq!(throttle.reserve(b, now).await, Duration::ZERO);
    }

    #[test]
    fn hosted_media_mirror_only_accepts_http_urls() {
        assert_eq!(
            mirrorable_media_url("https://cdn.example.test/photo.jpg")
                .map(|url| url.scheme().to_string()),
            Some("https".to_string())
        );
        assert_eq!(
            mirrorable_media_url("http://cdn.example.test/photo.jpg")
                .map(|url| url.scheme().to_string()),
            Some("http".to_string())
        );
        assert!(mirrorable_media_url("file:///tmp/plain.txt").is_none());
        assert!(mirrorable_media_url("not a url").is_none());
    }

    #[test]
    fn mirrored_object_body_hides_plaintext_and_roundtrips() {
        let file_key = crypto::generate_data_key();
        let plaintext = b"known hosted media bytes";
        let object_body = encrypted_object_body(&file_key, plaintext).expect("seal media");
        assert!(!object_body
            .windows(plaintext.len())
            .any(|window| window == plaintext));

        let (nonce, ciphertext) = object_body.split_at(12);
        let roundtrip = crypto::open(&file_key, nonce, ciphertext).expect("open media");
        assert_eq!(roundtrip, plaintext);
    }
}
