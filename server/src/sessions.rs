use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use uuid::Uuid;

use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::models::{QrFlowStatus, RealtimeEvent};
use crate::zalo_host::{
    HostedCredentials, HostedIncomingMessage, HostedQrEvent, HostedRealtimeEvent,
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
    throttle: SendThrottle,
}

struct HostedRealtimeContext<'a> {
    db: &'a crate::Db,
    config: &'a crate::Config,
    api: &'a zca_rust::apis::API,
    events: &'a tokio::sync::broadcast::Sender<RealtimeEvent>,
    user_id: Uuid,
    account_id: Uuid,
    source: &'a str,
}

impl Default for HostedSessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            qr_flows: Arc::new(Mutex::new(HashMap::new())),
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
            if let Err(e) =
                run_qr_flow(flow_id, user_id, db, config, events, qr_flows, sessions).await
            {
                tracing::warn!(flow_id = %flow_id, error = %e, "hosted QR flow failed");
            }
        });
        flow_id
    }

    pub async fn restore_active_sessions(
        &self,
        db: crate::Db,
        config: crate::Config,
        events: tokio::sync::broadcast::Sender<RealtimeEvent>,
    ) -> AppResult<usize> {
        let accounts = db.active_account_credentials().await?;
        let mut restored = 0usize;
        for account in accounts {
            let account_id = account.id;
            match restore_one_account(
                self.sessions.clone(),
                db.clone(),
                config.clone(),
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
        }
    }
}

async fn restore_one_account(
    sessions: Arc<Mutex<HashMap<Uuid, HostedSession>>>,
    db: crate::Db,
    config: crate::Config,
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
                api: api.as_ref(),
                events: &events,
                user_id: account.user_id,
                account_id: account.id,
                source: "restored",
            };
            handle_hosted_realtime_event(&ctx, event).await;
        }
    });
    Ok(())
}

struct HostedSessionTaskHandle {
    sessions: Arc<Mutex<HashMap<Uuid, HostedSession>>>,
}

async fn run_qr_flow(
    flow_id: Uuid,
    user_id: Uuid,
    db: crate::Db,
    config: crate::Config,
    events: tokio::sync::broadcast::Sender<RealtimeEvent>,
    qr_flows: Arc<Mutex<HashMap<Uuid, QrFlowStatus>>>,
    sessions: HostedSessionTaskHandle,
) -> AppResult<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<HostedQrEvent>(16);
    let flow_updates = qr_flows.clone();
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

    let user_secrets = db.user_secrets(user_id).await?;
    let data_key = crypto::unwrap_data_key_for_server(
        &config.master_key_seed,
        &user_secrets.server_key_nonce,
        &user_secrets.server_wrapped_data_key,
    )?;
    let credentials_json = serde_json::to_vec(&credentials).map_err(|_| AppError::Crypto)?;
    let (nonce, ciphertext) = crypto::seal(&data_key, &credentials_json)?;
    let account = db
        .upsert_account_credentials(
            user_id,
            &profile.account_id,
            profile.display_name.as_deref(),
            profile.avatar.as_deref(),
            &ciphertext,
            &nonce,
        )
        .await?;
    db.mark_account_active(account.id, None).await?;

    let (message_tx, mut message_rx) = tokio::sync::mpsc::channel::<HostedRealtimeEvent>(256);
    let listener_api = Arc::new(api);
    let listener = crate::zalo_host::start_message_listener(listener_api.clone(), message_tx)
        .await
        .map_err(|e| AppError::BadRequest(format!("listener failed: {e}")))?;

    // Re-login once to keep an API handle paired with the listener handle in the
    // manager. This avoids sharing the API value consumed above by Arc::new.
    let api = Arc::new(
        crate::zalo_host::login(credentials, true)
            .await
            .map_err(|e| AppError::BadRequest(format!("session login failed: {e}")))?,
    );
    sessions.sessions.lock().await.insert(
        account.id,
        HostedSession {
            account_id: account.id,
            state: HostedSessionState::Online,
            api,
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
                api: listener_api.as_ref(),
                events: &events,
                user_id,
                account_id: account.id,
                source: "qr",
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
            .apply_message_reaction(user_id, account_id, &reaction.msg_id, &ciphertext, &nonce)
            .await?;
    }
    Ok(())
}

async fn persist_hosted_message(
    db: &crate::Db,
    config: &crate::Config,
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
    let (rich_nonce, enc_rich) = encrypted_rich(&data_key, message.rich.as_ref())?;
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
    let _ = db
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
}
