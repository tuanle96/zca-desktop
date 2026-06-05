use chrono::{DateTime, Utc};
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use uuid::Uuid;

use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::models::{AccountView, ConversationView, DeviceView, FileInitRequest, FileView};

#[derive(Debug, Clone)]
pub struct Db {
    pool: PgPool,
}

#[derive(Debug, Clone)]
pub struct AuthDevice {
    pub user_id: Uuid,
    pub device_id: Uuid,
}

#[derive(Debug, Clone)]
pub struct UserSecrets {
    pub user_id: Uuid,
    pub recovery_key_hash: String,
    pub wrapped_data_key: Vec<u8>,
    pub server_key_nonce: Vec<u8>,
    pub server_wrapped_data_key: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct AccountCredential {
    pub id: Uuid,
    pub user_id: Uuid,
    pub zalo_account_id: String,
    pub enc_credentials: Vec<u8>,
    pub credentials_nonce: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct FileSecret {
    pub id: Uuid,
    pub user_id: Uuid,
    pub account_id: Option<Uuid>,
    pub object_key: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: i64,
    pub content_sha256: String,
    pub enc_file_key: Vec<u8>,
    pub file_key_nonce: Vec<u8>,
}

pub struct MessageCiphertextRow {
    pub id: Uuid,
    pub account_id: Uuid,
    pub conversation_id: Uuid,
    pub msg_id: String,
    pub from_id: Option<String>,
    pub from_name: Option<String>,
    pub from_avatar: Option<String>,
    pub enc_body: Option<Vec<u8>>,
    pub body_nonce: Option<Vec<u8>>,
    pub enc_rich: Option<Vec<u8>>,
    pub rich_nonce: Option<Vec<u8>>,
    pub outgoing: bool,
    pub kind: String,
    pub observed_at: DateTime<Utc>,
    pub deleted: bool,
}

pub struct MessageRichCiphertext {
    pub enc_rich: Option<Vec<u8>>,
    pub rich_nonce: Option<Vec<u8>>,
}

impl Db {
    pub async fn connect(database_url: &str) -> AppResult<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> AppResult<()> {
        sqlx::migrate!("./migrations")
            .run(&self.pool)
            .await
            .map_err(|e| AppError::BadRequest(format!("migration failed: {e}")))?;
        Ok(())
    }

    pub async fn migrate_down_to(&self, target_version: i64) -> AppResult<()> {
        sqlx::migrate!("./migrations")
            .undo(&self.pool, target_version)
            .await
            .map_err(|e| AppError::BadRequest(format!("migration down failed: {e}")))?;
        Ok(())
    }

    pub async fn insert_magic_link(
        &self,
        email: &str,
        token_hash: &str,
        expires_at: DateTime<Utc>,
    ) -> AppResult<()> {
        sqlx::query("INSERT INTO magic_links (email, token_hash, expires_at) VALUES ($1, $2, $3)")
            .bind(email)
            .bind(token_hash)
            .bind(expires_at)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn consume_magic_link(&self, email: &str, token_hash: &str) -> AppResult<()> {
        let changed = sqlx::query(
            "UPDATE magic_links
             SET used_at = now()
             WHERE email = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()",
        )
        .bind(email)
        .bind(token_hash)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if changed == 0 {
            return Err(AppError::Unauthorized);
        }
        Ok(())
    }

    pub async fn magic_link_is_valid(&self, email: &str, token_hash: &str) -> AppResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM magic_links
                WHERE email = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
             )",
        )
        .bind(email)
        .bind(token_hash)
        .fetch_one(&self.pool)
        .await?;
        Ok(exists)
    }

    pub async fn count_magic_links_since(
        &self,
        email: &str,
        since: DateTime<Utc>,
    ) -> AppResult<i64> {
        sqlx::query_scalar(
            "SELECT count(*)::bigint FROM magic_links
             WHERE email = $1 AND created_at >= $2",
        )
        .bind(email)
        .bind(since)
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::from)
    }

    pub async fn get_or_create_user(
        &self,
        email: &str,
        recovery_key: &str,
        wrapped_data_key: &[u8],
        server_key_nonce: &[u8],
        server_wrapped_data_key: &[u8],
    ) -> AppResult<(Uuid, bool)> {
        if let Some(row) = sqlx::query("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&self.pool)
            .await?
        {
            return Ok((row.get("id"), false));
        }

        let recovery_key_hash = crypto::hash_recovery_key(recovery_key)?;
        let row = sqlx::query(
            "INSERT INTO users
                (email, recovery_key_hash, wrapped_data_key, server_key_nonce, server_wrapped_data_key)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id",
        )
        .bind(email)
        .bind(recovery_key_hash)
        .bind(wrapped_data_key)
        .bind(server_key_nonce)
        .bind(server_wrapped_data_key)
        .fetch_one(&self.pool)
        .await?;
        Ok((row.get("id"), true))
    }

    pub async fn user_secrets(&self, user_id: Uuid) -> AppResult<UserSecrets> {
        let row = sqlx::query(
            "SELECT id, recovery_key_hash, wrapped_data_key, server_key_nonce, server_wrapped_data_key
             FROM users WHERE id = $1",
        )
            .bind(user_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(AppError::NotFound)?;
        Ok(UserSecrets {
            user_id: row.get("id"),
            recovery_key_hash: row.get("recovery_key_hash"),
            wrapped_data_key: row.get("wrapped_data_key"),
            server_key_nonce: row.get("server_key_nonce"),
            server_wrapped_data_key: row.get("server_wrapped_data_key"),
        })
    }

    pub async fn upsert_account_credentials(
        &self,
        user_id: Uuid,
        zalo_account_id: &str,
        display_name: Option<&str>,
        avatar: Option<&str>,
        enc_credentials: &[u8],
        credentials_nonce: &[u8],
    ) -> AppResult<AccountView> {
        sqlx::query_as::<_, AccountView>(
            "INSERT INTO cloud_accounts
                (user_id, zalo_account_id, display_name, avatar, state, enc_credentials, credentials_nonce)
             VALUES ($1, $2, $3, $4, 'active', $5, $6)
             ON CONFLICT(user_id, zalo_account_id) DO UPDATE SET
                display_name = excluded.display_name,
                avatar = excluded.avatar,
                state = 'active',
                enc_credentials = excluded.enc_credentials,
                credentials_nonce = excluded.credentials_nonce,
                updated_at = now()
             RETURNING id, zalo_account_id, display_name, avatar, state",
        )
        .bind(user_id)
        .bind(zalo_account_id)
        .bind(display_name)
        .bind(avatar)
        .bind(enc_credentials)
        .bind(credentials_nonce)
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::from)
    }

    pub async fn account_credentials(
        &self,
        user_id: Uuid,
        account_id: Uuid,
    ) -> AppResult<AccountCredential> {
        let row = sqlx::query(
            "SELECT id, user_id, zalo_account_id, enc_credentials, credentials_nonce
             FROM cloud_accounts
             WHERE user_id = $1 AND id = $2 AND enc_credentials IS NOT NULL AND credentials_nonce IS NOT NULL",
        )
        .bind(user_id)
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AppError::NotFound)?;
        Ok(AccountCredential {
            id: row.get("id"),
            user_id: row.get("user_id"),
            zalo_account_id: row.get("zalo_account_id"),
            enc_credentials: row.get("enc_credentials"),
            credentials_nonce: row.get("credentials_nonce"),
        })
    }

    pub async fn active_account_credentials(&self) -> AppResult<Vec<AccountCredential>> {
        let rows = sqlx::query(
            "SELECT id, user_id, zalo_account_id, enc_credentials, credentials_nonce
             FROM cloud_accounts
             WHERE state = 'active' AND enc_credentials IS NOT NULL AND credentials_nonce IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| AccountCredential {
                id: row.get("id"),
                user_id: row.get("user_id"),
                zalo_account_id: row.get("zalo_account_id"),
                enc_credentials: row.get("enc_credentials"),
                credentials_nonce: row.get("credentials_nonce"),
            })
            .collect())
    }

    pub async fn insert_device(
        &self,
        user_id: Uuid,
        name: &str,
        token_hash: &str,
    ) -> AppResult<Uuid> {
        let row = sqlx::query(
            "INSERT INTO devices (user_id, name, token_hash, last_seen_at)
             VALUES ($1, $2, $3, now())
             RETURNING id",
        )
        .bind(user_id)
        .bind(name)
        .bind(token_hash)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    pub async fn auth_device(&self, token_hash: &str) -> AppResult<AuthDevice> {
        let row = sqlx::query(
            "UPDATE devices SET last_seen_at = now()
             WHERE token_hash = $1 AND revoked_at IS NULL
             RETURNING id, user_id",
        )
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AppError::Unauthorized)?;
        Ok(AuthDevice {
            device_id: row.get("id"),
            user_id: row.get("user_id"),
        })
    }

    pub async fn list_devices(&self, user_id: Uuid) -> AppResult<Vec<DeviceView>> {
        sqlx::query_as::<_, DeviceView>(
            "SELECT id, name, revoked_at, created_at, last_seen_at
             FROM devices WHERE user_id = $1 ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::from)
    }

    pub async fn revoke_device(&self, user_id: Uuid, device_id: Uuid) -> AppResult<()> {
        let changed =
            sqlx::query("UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND id = $2")
                .bind(user_id)
                .bind(device_id)
                .execute(&self.pool)
                .await?
                .rows_affected();
        if changed == 0 {
            return Err(AppError::NotFound);
        }
        Ok(())
    }

    pub async fn insert_audit_event(
        &self,
        user_id: Option<Uuid>,
        device_id: Option<Uuid>,
        event_kind: &str,
        subject_id: Option<&str>,
        meta: serde_json::Value,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO audit_events (user_id, device_id, event_kind, subject_id, meta)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(user_id)
        .bind(device_id)
        .bind(event_kind)
        .bind(subject_id)
        .bind(meta)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_accounts(&self, user_id: Uuid) -> AppResult<Vec<AccountView>> {
        sqlx::query_as::<_, AccountView>(
            "SELECT id, zalo_account_id, display_name, avatar, state
             FROM cloud_accounts WHERE user_id = $1 ORDER BY updated_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::from)
    }

    pub async fn account_status(&self, user_id: Uuid, account_id: Uuid) -> AppResult<AccountView> {
        sqlx::query_as::<_, AccountView>(
            "SELECT id, zalo_account_id, display_name, avatar, state
             FROM cloud_accounts WHERE user_id = $1 AND id = $2",
        )
        .bind(user_id)
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AppError::NotFound)
    }

    pub async fn delete_account(&self, user_id: Uuid, account_id: Uuid) -> AppResult<()> {
        let changed = sqlx::query("DELETE FROM cloud_accounts WHERE user_id = $1 AND id = $2")
            .bind(user_id)
            .bind(account_id)
            .execute(&self.pool)
            .await?
            .rows_affected();
        if changed == 0 {
            return Err(AppError::NotFound);
        }
        Ok(())
    }

    pub async fn set_hosted_session_state(
        &self,
        account_id: Uuid,
        state: &str,
        last_error: Option<&str>,
    ) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO hosted_sessions (account_id, state, generation, started_at, stopped_at, last_error, updated_at)
             VALUES ($1, $2, 1, CASE WHEN $2 = 'online' THEN now() ELSE NULL END,
                     CASE WHEN $2 = 'stopped' THEN now() ELSE NULL END, $3, now())
             ON CONFLICT(account_id) DO UPDATE SET
                state = excluded.state,
                generation = hosted_sessions.generation + 1,
                started_at = CASE WHEN excluded.state = 'online' THEN now() ELSE hosted_sessions.started_at END,
                stopped_at = CASE WHEN excluded.state = 'stopped' THEN now() ELSE hosted_sessions.stopped_at END,
                last_error = excluded.last_error,
                updated_at = now()",
        )
        .bind(account_id)
        .bind(state)
        .bind(last_error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_account_state(
        &self,
        account_id: Uuid,
        state: &str,
        last_error: Option<&str>,
    ) -> AppResult<()> {
        sqlx::query(
            "UPDATE cloud_accounts
             SET state = $2, updated_at = now()
             WHERE id = $1",
        )
        .bind(account_id)
        .bind(state)
        .execute(&self.pool)
        .await?;
        self.set_hosted_session_state(account_id, state, last_error)
            .await?;
        Ok(())
    }

    pub async fn mark_account_active(
        &self,
        account_id: Uuid,
        last_error: Option<&str>,
    ) -> AppResult<()> {
        sqlx::query(
            "UPDATE cloud_accounts
             SET state = 'active', updated_at = now()
             WHERE id = $1",
        )
        .bind(account_id)
        .execute(&self.pool)
        .await?;
        self.set_hosted_session_state(account_id, "online", last_error)
            .await?;
        Ok(())
    }

    pub async fn upsert_conversation(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        thread_id: &str,
        kind: &str,
        title: Option<&str>,
        avatar: Option<&str>,
    ) -> AppResult<Uuid> {
        let row = sqlx::query(
            "INSERT INTO conversations (user_id, account_id, thread_id, kind, title, avatar, last_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT(account_id, thread_id) DO UPDATE SET
                kind = excluded.kind,
                title = COALESCE(excluded.title, conversations.title),
                avatar = COALESCE(excluded.avatar, conversations.avatar),
                last_at = now()
             RETURNING id",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(thread_id)
        .bind(kind)
        .bind(title)
        .bind(avatar)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_message_ciphertext(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        conversation_id: Uuid,
        msg_id: &str,
        from_id: Option<&str>,
        from_name: Option<&str>,
        from_avatar: Option<&str>,
        enc_body: Option<&[u8]>,
        body_nonce: Option<&[u8]>,
        enc_rich: Option<&[u8]>,
        rich_nonce: Option<&[u8]>,
        outgoing: bool,
        kind: &str,
        z_ts: Option<&str>,
    ) -> AppResult<Uuid> {
        let row = sqlx::query(
            "INSERT INTO messages
                (user_id, account_id, conversation_id, msg_id, from_id, from_name,
                 from_avatar, enc_body, body_nonce, enc_rich, rich_nonce, outgoing, kind, z_ts)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT(account_id, msg_id) DO UPDATE SET
                from_avatar = COALESCE(excluded.from_avatar, messages.from_avatar),
                enc_rich = COALESCE(excluded.enc_rich, messages.enc_rich),
                rich_nonce = COALESCE(excluded.rich_nonce, messages.rich_nonce),
                observed_at = messages.observed_at
             RETURNING id",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(conversation_id)
        .bind(msg_id)
        .bind(from_id)
        .bind(from_name)
        .bind(from_avatar)
        .bind(enc_body)
        .bind(body_nonce)
        .bind(enc_rich)
        .bind(rich_nonce)
        .bind(outgoing)
        .bind(kind)
        .bind(z_ts)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("id"))
    }

    pub async fn list_conversations(
        &self,
        user_id: Uuid,
        account_id: Option<Uuid>,
    ) -> AppResult<Vec<ConversationView>> {
        if let Some(account_id) = account_id {
            return sqlx::query_as::<_, ConversationView>(
                "SELECT id, account_id, thread_id, kind, title, avatar, last_at, unread
                 FROM conversations
                 WHERE user_id = $1 AND account_id = $2 AND thread_id <> ''
                 ORDER BY COALESCE(last_at, '-infinity'::timestamptz) DESC",
            )
            .bind(user_id)
            .bind(account_id)
            .fetch_all(&self.pool)
            .await
            .map_err(AppError::from);
        }
        sqlx::query_as::<_, ConversationView>(
            "SELECT id, account_id, thread_id, kind, title, avatar, last_at, unread
             FROM conversations WHERE user_id = $1 AND thread_id <> ''
             ORDER BY COALESCE(last_at, '-infinity'::timestamptz) DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::from)
    }

    pub async fn update_conversation_metadata(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        thread_id: &str,
        title: Option<&str>,
        avatar: Option<&str>,
    ) -> AppResult<()> {
        sqlx::query(
            "UPDATE conversations
             SET title = COALESCE($4, title),
                 avatar = COALESCE($5, avatar)
             WHERE user_id = $1 AND account_id = $2 AND thread_id = $3",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(thread_id)
        .bind(title)
        .bind(avatar)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_messages(
        &self,
        user_id: Uuid,
        conversation_id: Uuid,
        limit: i64,
    ) -> AppResult<Vec<MessageCiphertextRow>> {
        let rows = sqlx::query(
            "SELECT id, account_id, conversation_id, msg_id, from_id, from_name, from_avatar,
                    enc_body, body_nonce, enc_rich, rich_nonce,
                    outgoing, kind, observed_at, deleted
             FROM messages WHERE user_id = $1 AND conversation_id = $2
             ORDER BY observed_at DESC LIMIT $3",
        )
        .bind(user_id)
        .bind(conversation_id)
        .bind(limit.clamp(1, 500))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| MessageCiphertextRow {
                id: row.get("id"),
                account_id: row.get("account_id"),
                conversation_id: row.get("conversation_id"),
                msg_id: row.get("msg_id"),
                from_id: row.get("from_id"),
                from_name: row.get("from_name"),
                from_avatar: row.get("from_avatar"),
                enc_body: row.get("enc_body"),
                body_nonce: row.get("body_nonce"),
                enc_rich: row.get("enc_rich"),
                rich_nonce: row.get("rich_nonce"),
                outgoing: row.get("outgoing"),
                kind: row.get("kind"),
                observed_at: row.get("observed_at"),
                deleted: row.get("deleted"),
            })
            .collect())
    }

    pub async fn update_message_rich(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        msg_id: &str,
        enc_rich: &[u8],
        rich_nonce: &[u8],
    ) -> AppResult<bool> {
        let changed = sqlx::query(
            "UPDATE messages
             SET enc_rich = $4, rich_nonce = $5
             WHERE user_id = $1 AND account_id = $2 AND msg_id = $3",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(msg_id)
        .bind(enc_rich)
        .bind(rich_nonce)
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(changed > 0)
    }

    pub async fn message_rich_ciphertext(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        msg_id: &str,
    ) -> AppResult<Option<MessageRichCiphertext>> {
        let row = sqlx::query(
            "SELECT enc_rich, rich_nonce
             FROM messages
             WHERE user_id = $1 AND account_id = $2 AND msg_id = $3",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(msg_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| MessageRichCiphertext {
            enc_rich: row.get("enc_rich"),
            rich_nonce: row.get("rich_nonce"),
        }))
    }

    pub async fn mark_message_deleted(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        msg_id: &str,
    ) -> AppResult<bool> {
        let changed = sqlx::query(
            "UPDATE messages
             SET deleted = true
             WHERE user_id = $1 AND account_id = $2 AND msg_id = $3",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(msg_id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        Ok(changed > 0)
    }

    pub async fn update_message_sender_avatar(
        &self,
        user_id: Uuid,
        account_id: Uuid,
        msg_id: &str,
        from_avatar: &str,
    ) -> AppResult<()> {
        sqlx::query(
            "UPDATE messages
             SET from_avatar = $4
             WHERE user_id = $1 AND account_id = $2 AND msg_id = $3",
        )
        .bind(user_id)
        .bind(account_id)
        .bind(msg_id)
        .bind(from_avatar)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn insert_file(
        &self,
        user_id: Uuid,
        req: &FileInitRequest,
        object_key: &str,
        enc_file_key: &[u8],
        file_key_nonce: &[u8],
    ) -> AppResult<FileView> {
        sqlx::query_as::<_, FileView>(
            "INSERT INTO files
                (user_id, account_id, conversation_id, message_id, object_key, filename, mime,
                 size_bytes, content_sha256, enc_file_key, file_key_nonce)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id, object_key, filename, mime, size_bytes, content_sha256, created_at",
        )
        .bind(user_id)
        .bind(req.account_id)
        .bind(req.conversation_id)
        .bind(req.message_id)
        .bind(object_key)
        .bind(&req.filename)
        .bind(&req.mime)
        .bind(req.size_bytes)
        .bind(&req.content_sha256)
        .bind(enc_file_key)
        .bind(file_key_nonce)
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::from)
    }

    pub async fn get_file(&self, user_id: Uuid, file_id: Uuid) -> AppResult<FileView> {
        sqlx::query_as::<_, FileView>(
            "SELECT id, object_key, filename, mime, size_bytes, content_sha256, created_at
             FROM files WHERE user_id = $1 AND id = $2",
        )
        .bind(user_id)
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AppError::NotFound)
    }

    pub async fn file_secret(&self, user_id: Uuid, file_id: Uuid) -> AppResult<FileSecret> {
        let row = sqlx::query(
            "SELECT id, user_id, account_id, object_key, filename, mime, size_bytes,
                    content_sha256, enc_file_key, file_key_nonce
               FROM files WHERE user_id = $1 AND id = $2",
        )
        .bind(user_id)
        .bind(file_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(AppError::NotFound)?;
        Ok(FileSecret {
            id: row.get("id"),
            user_id: row.get("user_id"),
            account_id: row.get("account_id"),
            object_key: row.get("object_key"),
            filename: row.get("filename"),
            mime: row.get("mime"),
            size_bytes: row.get("size_bytes"),
            content_sha256: row.get("content_sha256"),
            enc_file_key: row.get("enc_file_key"),
            file_key_nonce: row.get("file_key_nonce"),
        })
    }
}
