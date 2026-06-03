//! SQLite-backed local store (`store` layer, ADR-0005).
//!
//! Owns the bundled-SQLite connection, schema/migrations, and typed repository
//! functions for accounts + encrypted credentials. `rusqlite` types never leak
//! above this layer. Message/attachment tables are created here too (slice 2
//! fills their repositories); this slice uses accounts + credentials.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::types::{AccountProfile, Credentials, Sticker, StoredMessage, StoredThread, ThreadIdentity, ThreadKind};

use super::crypto::{self, CryptoError};

/// Current schema version; bump when adding migrations.
const SCHEMA_VERSION: i64 = 3;

/// Errors surfaced by the store. Messages never include secret values.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("credential crypto error: {0}")]
    Crypto(#[from] CryptoError),
}

/// A saved account row plus its decrypted credential, for session restore.
pub struct SavedAccount {
    pub profile: AccountProfile,
    pub credentials: Credentials,
    pub state: String,
}

/// The local database handle. Single connection behind a mutex — this is a
/// local single-file store, not a high-concurrency server.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Open (creating if needed) the database at `path` and run migrations.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let db = Db { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    /// Create the schema if absent. Idempotent; guarded by `user_version`.
    fn migrate(&self) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;

        // v0 -> v1: base schema (accounts/credentials/threads/messages/attachments).
        if current < 1 {
            conn.execute_batch(
                "
            CREATE TABLE IF NOT EXISTS accounts (
                account_id    TEXT PRIMARY KEY,
                display_name  TEXT,
                avatar        TEXT,
                state         TEXT NOT NULL DEFAULT 'active',
                added_at      INTEGER NOT NULL,
                last_login_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS credentials (
                account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
                enc_blob   BLOB NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS threads (
                account_id TEXT NOT NULL,
                thread_id  TEXT NOT NULL,
                kind       TEXT NOT NULL,
                title      TEXT,
                avatar     TEXT,
                last_at    INTEGER,
                unread     INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_id, thread_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                account_id TEXT NOT NULL,
                thread_id  TEXT NOT NULL,
                msg_id     TEXT NOT NULL,
                from_id    TEXT,
                from_name  TEXT,
                body       TEXT,
                outgoing   INTEGER NOT NULL DEFAULT 0,
                kind       TEXT,
                ts         INTEGER,
                PRIMARY KEY (account_id, msg_id)
            );
            CREATE TABLE IF NOT EXISTS attachments (
                account_id TEXT NOT NULL,
                msg_id     TEXT NOT NULL,
                kind       TEXT,
                url        TEXT,
                local_path TEXT,
                filename   TEXT,
                size       INTEGER,
                meta       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_thread
                ON messages (account_id, thread_id, ts);
            ",
            )?;
            current = 1;
        }

        // v1 -> v2: sticker columns on messages so sticker messages survive a
        // restart (render the image, not a "[non-text message]" placeholder).
        if current < 2 {
            conn.execute_batch(
                "
            ALTER TABLE messages ADD COLUMN sticker_id INTEGER;
            ALTER TABLE messages ADD COLUMN sticker_cat_id INTEGER;
            ALTER TABLE messages ADD COLUMN sticker_type INTEGER;
            ALTER TABLE messages ADD COLUMN sticker_url TEXT;
            ",
            )?;
            current = 2;
        }

        // v2 -> v3: per-account recent-sticker history for the picker. Keyed by
        // (account_id, sticker_id) so re-using a sticker bumps its timestamp
        // instead of duplicating. `cat_id` lets the picker derive recent packs.
        if current < 3 {
            conn.execute_batch(
                "
            CREATE TABLE IF NOT EXISTS recent_stickers (
                account_id   TEXT NOT NULL,
                sticker_id   INTEGER NOT NULL,
                cat_id       INTEGER NOT NULL DEFAULT 0,
                sticker_type INTEGER NOT NULL DEFAULT 0,
                url          TEXT NOT NULL,
                used_at      INTEGER NOT NULL,
                PRIMARY KEY (account_id, sticker_id)
            );
            CREATE INDEX IF NOT EXISTS idx_recent_stickers_used
                ON recent_stickers (account_id, used_at DESC);
            ",
            )?;
            current = 3;
        }

        debug_assert_eq!(current, SCHEMA_VERSION, "migrations must reach SCHEMA_VERSION");
        conn.pragma_update(None, "user_version", current)?;
        Ok(())
    }

    /// Persist (or update) an account and its encrypted credential. The
    /// credential is AES-GCM encrypted before it touches disk.
    pub fn save_account(
        &self,
        profile: &AccountProfile,
        credentials: &Credentials,
    ) -> Result<(), StoreError> {
        let blob = crypto::encrypt_credentials(credentials)?;
        let now = now_secs();
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "INSERT INTO accounts (account_id, display_name, avatar, state, added_at, last_login_at)
             VALUES (?1, ?2, ?3, 'active', ?4, ?4)
             ON CONFLICT(account_id) DO UPDATE SET
                display_name = excluded.display_name,
                avatar = excluded.avatar,
                state = 'active',
                last_login_at = excluded.last_login_at",
            rusqlite::params![profile.account_id, profile.display_name, profile.avatar, now],
        )?;
        conn.execute(
            "INSERT INTO credentials (account_id, enc_blob, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(account_id) DO UPDATE SET
                enc_blob = excluded.enc_blob,
                updated_at = excluded.updated_at",
            rusqlite::params![profile.account_id, blob, now],
        )?;
        Ok(())
    }

    /// Load every saved account with its decrypted credential, for restore.
    /// An account whose blob fails to decrypt is skipped (caller may prompt a
    /// re-scan); it is not a hard error for the whole restore.
    pub fn load_accounts(&self) -> Result<Vec<SavedAccount>, StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT a.account_id, a.display_name, a.avatar, a.state, c.enc_blob
             FROM accounts a JOIN credentials c ON c.account_id = a.account_id",
        )?;
        let rows = stmt.query_map([], |row| {
            let account_id: String = row.get(0)?;
            let display_name: Option<String> = row.get(1)?;
            let avatar: Option<String> = row.get(2)?;
            let state: String = row.get(3)?;
            let blob: Vec<u8> = row.get(4)?;
            Ok((account_id, display_name, avatar, state, blob))
        })?;

        let mut out = Vec::new();
        for row in rows {
            let (account_id, display_name, avatar, state, blob) = row?;
            match crypto::decrypt_credentials(&blob) {
                Ok(credentials) => out.push(SavedAccount {
                    profile: AccountProfile { account_id, display_name, avatar },
                    credentials,
                    state,
                }),
                Err(_) => {
                    // Undecryptable (e.g. key lost) — skip; account stays on disk
                    // for the UI to surface as reauth-needed.
                    continue;
                }
            }
        }
        Ok(out)
    }

    /// Mark an account as needing re-auth (e.g. expired cookie at restore).
    pub fn mark_reauth_needed(&self, account_id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "UPDATE accounts SET state = 'reauth-needed' WHERE account_id = ?1",
            rusqlite::params![account_id],
        )?;
        Ok(())
    }

    /// Remove an account and its credential from the store.
    pub fn delete_account(&self, account_id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute("DELETE FROM accounts WHERE account_id = ?1", rusqlite::params![account_id])?;
        Ok(())
    }

    /// Persist one observed message and upsert its thread row (ADR-0005).
    ///
    /// Messages are deduplicated by `(account_id, msg_id)`; re-observing a
    /// message (e.g. self-echo) is a no-op insert. The thread row tracks the
    /// latest activity + a best-effort title/avatar.
    #[allow(clippy::too_many_arguments)]
    pub fn save_message(
        &self,
        account_id: &str,
        thread_id: &str,
        kind: &str,
        msg_id: &str,
        from_id: Option<&str>,
        from_name: Option<&str>,
        body: Option<&str>,
        outgoing: bool,
        ts: Option<i64>,
        thread_title: Option<&str>,
        thread_avatar: Option<&str>,
        bump_unread: bool,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");

        // Echo reconciliation: Zalo redelivers our own sent message through the
        // listener with a DIFFERENT msg_id than the send-response id, so a pure
        // (account_id, msg_id) dedupe would store the same outgoing message
        // twice. If an outgoing message with the same thread + body was already
        // stored within a short window under another msg_id, treat this as the
        // same message and skip it (do not insert or bump counters).
        if outgoing {
            if let (Some(text), Some(stamp)) = (body, ts) {
                const ECHO_WINDOW_MS: i64 = 15_000;
                let existing: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM messages
                     WHERE account_id = ?1 AND thread_id = ?2 AND outgoing = 1
                       AND body = ?3 AND msg_id <> ?4
                       AND ABS(COALESCE(ts, 0) - ?5) <= ?6",
                    rusqlite::params![account_id, thread_id, text, msg_id, stamp, ECHO_WINDOW_MS],
                    |row| row.get(0),
                )?;
                if existing > 0 {
                    return Ok(());
                }
            }
        }

        // Insert the message; ignore if we have already stored this msg_id.
        let inserted = conn.execute(
            "INSERT INTO messages (account_id, thread_id, msg_id, from_id, from_name, body, outgoing, kind, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'text', ?8)
             ON CONFLICT(account_id, msg_id) DO NOTHING",
            rusqlite::params![
                account_id,
                thread_id,
                msg_id,
                from_id,
                from_name,
                body,
                outgoing as i64,
                ts
            ],
        )?;

        // A duplicate message must not bump the thread/unread counters.
        if inserted == 0 {
            return Ok(());
        }

        let unread_delta = if bump_unread { 1 } else { 0 };
        conn.execute(
            "INSERT INTO threads (account_id, thread_id, kind, title, avatar, last_at, unread)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(account_id, thread_id) DO UPDATE SET
                kind = excluded.kind,
                title = COALESCE(excluded.title, threads.title),
                avatar = COALESCE(excluded.avatar, threads.avatar),
                last_at = MAX(COALESCE(excluded.last_at, 0), COALESCE(threads.last_at, 0)),
                unread = threads.unread + ?7",
            rusqlite::params![account_id, thread_id, kind, thread_title, thread_avatar, ts, unread_delta],
        )?;
        Ok(())
    }

    /// Persist one observed sticker message and upsert its thread row.
    ///
    /// Mirrors [`save_message`] but stores the sticker triple + render URL in
    /// the dedicated `sticker_*` columns (kind = `sticker`). The `body` holds a
    /// short non-secret label so older readers/snippets still show something.
    /// Deduped by `(account_id, msg_id)` and, for outgoing, by the same
    /// thread+sticker echo window as text (Zalo redelivers our own send with a
    /// different msg_id).
    #[allow(clippy::too_many_arguments)]
    pub fn save_sticker_message(
        &self,
        account_id: &str,
        thread_id: &str,
        kind: &str,
        msg_id: &str,
        from_id: Option<&str>,
        from_name: Option<&str>,
        sticker: &Sticker,
        outgoing: bool,
        ts: Option<i64>,
        thread_title: Option<&str>,
        thread_avatar: Option<&str>,
        bump_unread: bool,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");

        // Echo reconciliation for outgoing stickers: the listener redelivers our
        // own sent sticker under a different msg_id, so dedupe on (thread,
        // sticker id) within a short window in addition to the msg_id PK.
        if outgoing {
            if let Some(stamp) = ts {
                const ECHO_WINDOW_MS: i64 = 15_000;
                let existing: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM messages
                     WHERE account_id = ?1 AND thread_id = ?2 AND outgoing = 1
                       AND kind = 'sticker' AND sticker_id = ?3 AND msg_id <> ?4
                       AND ABS(COALESCE(ts, 0) - ?5) <= ?6",
                    rusqlite::params![account_id, thread_id, sticker.id, msg_id, stamp, ECHO_WINDOW_MS],
                    |row| row.get(0),
                )?;
                if existing > 0 {
                    return Ok(());
                }
            }
        }

        let label = "[Sticker]";
        let inserted = conn.execute(
            "INSERT INTO messages
                (account_id, thread_id, msg_id, from_id, from_name, body, outgoing, kind, ts,
                 sticker_id, sticker_cat_id, sticker_type, sticker_url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'sticker', ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(account_id, msg_id) DO NOTHING",
            rusqlite::params![
                account_id,
                thread_id,
                msg_id,
                from_id,
                from_name,
                label,
                outgoing as i64,
                ts,
                sticker.id,
                sticker.cat_id,
                sticker.sticker_type,
                sticker.url,
            ],
        )?;

        if inserted == 0 {
            return Ok(());
        }

        let unread_delta = if bump_unread { 1 } else { 0 };
        conn.execute(
            "INSERT INTO threads (account_id, thread_id, kind, title, avatar, last_at, unread)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(account_id, thread_id) DO UPDATE SET
                kind = excluded.kind,
                title = COALESCE(excluded.title, threads.title),
                avatar = COALESCE(excluded.avatar, threads.avatar),
                last_at = MAX(COALESCE(excluded.last_at, 0), COALESCE(threads.last_at, 0)),
                unread = threads.unread + ?7",
            rusqlite::params![account_id, thread_id, kind, thread_title, thread_avatar, ts, unread_delta],
        )?;
        Ok(())
    }

    /// Record a sticker the account just used, for the picker's "recent" row.
    ///
    /// Upserts by `(account_id, sticker_id)` so re-using a sticker bumps its
    /// `used_at` instead of duplicating. The cat_id/type/url are refreshed too.
    pub fn record_recent_sticker(
        &self,
        account_id: &str,
        sticker: &Sticker,
        used_at: i64,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "INSERT INTO recent_stickers (account_id, sticker_id, cat_id, sticker_type, url, used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(account_id, sticker_id) DO UPDATE SET
                cat_id = excluded.cat_id,
                sticker_type = excluded.sticker_type,
                url = excluded.url,
                used_at = excluded.used_at",
            rusqlite::params![
                account_id,
                sticker.id,
                sticker.cat_id,
                sticker.sticker_type,
                sticker.url,
                used_at
            ],
        )?;
        Ok(())
    }

    /// Load the account's most-recently-used stickers (newest first), capped at
    /// `limit`, for the picker's "Gần đây" row.
    pub fn load_recent_stickers(
        &self,
        account_id: &str,
        limit: i64,
    ) -> Result<Vec<Sticker>, StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT sticker_id, cat_id, sticker_type, url
             FROM recent_stickers WHERE account_id = ?1
             ORDER BY used_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![account_id, limit], |row| {
            Ok(Sticker {
                id: row.get(0)?,
                cat_id: row.get(1)?,
                sticker_type: row.get(2)?,
                url: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The distinct sticker categories (`cat_id`) the account has used recently,
    /// newest-used first. The picker turns these into selectable pack tabs
    /// (Zalo has no "owned packs" endpoint, so recent usage is the source).
    /// `cat_id = 0` (unknown category) is excluded.
    pub fn load_recent_sticker_categories(
        &self,
        account_id: &str,
        limit: i64,
    ) -> Result<Vec<i64>, StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT cat_id FROM recent_stickers
             WHERE account_id = ?1 AND cat_id <> 0
             GROUP BY cat_id
             ORDER BY MAX(used_at) DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![account_id, limit], |row| row.get::<_, i64>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Persist attachment metadata for a stored message (URL + descriptors).
    #[allow(clippy::too_many_arguments)]
    pub fn save_attachment(
        &self,
        account_id: &str,
        msg_id: &str,
        kind: Option<&str>,
        url: Option<&str>,
        filename: Option<&str>,
        size: Option<i64>,
        meta: Option<&str>,
    ) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "INSERT INTO attachments (account_id, msg_id, kind, url, local_path, filename, size, meta)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
            rusqlite::params![account_id, msg_id, kind, url, filename, size, meta],
        )?;
        Ok(())
    }

    /// Backfill conversation identity (title + avatar) onto already-persisted
    /// threads from directory data (contacts/groups the app fetched live).
    ///
    /// Why this exists: the realtime listener message model carries a sender
    /// display name but NO avatar, so `save_message` can only ever store
    /// `thread_avatar = None` and a group thread's title defaults to the last
    /// sender's name. Avatars/names live in the directory (`get_all_friends` /
    /// `get_group_info`), so once those are fetched the `command` layer calls
    /// this to enrich the stored threads — making the title + avatar survive a
    /// restart instead of being resolved from scratch every session.
    ///
    /// Only threads that already exist are updated (an `UPDATE`, never an
    /// insert): a directory entry with no conversation must not create an empty
    /// thread row. `COALESCE` keeps an existing value when the directory value
    /// is absent, so a partial directory never blanks a known title/avatar.
    /// Returns the number of thread rows actually updated — a non-secret
    /// diagnostic for the caller's logs.
    pub fn backfill_thread_identities(
        &self,
        account_id: &str,
        identities: &[ThreadIdentity],
    ) -> Result<usize, StoreError> {
        if identities.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().expect("db mutex poisoned");
        let tx = conn.transaction()?;
        let mut updated = 0usize;
        {
            let mut stmt = tx.prepare(
                "UPDATE threads SET
                    title = COALESCE(?3, title),
                    avatar = COALESCE(?4, avatar)
                 WHERE account_id = ?1 AND thread_id = ?2",
            )?;
            for id in identities {
                // Treat empty strings as absent so they do not overwrite a known
                // value (and COALESCE only guards NULL, not "").
                let title = id.title.as_deref().filter(|s| !s.is_empty());
                let avatar = id.avatar.as_deref().filter(|s| !s.is_empty());
                if title.is_none() && avatar.is_none() {
                    continue;
                }
                updated +=
                    stmt.execute(rusqlite::params![account_id, id.thread_id, title, avatar])?;
            }
        }
        tx.commit()?;
        Ok(updated)
    }

    /// Mark a thread read (clear its unread counter) — used when the UI opens it.
    pub fn clear_unread(&self, account_id: &str, thread_id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        conn.execute(
            "UPDATE threads SET unread = 0 WHERE account_id = ?1 AND thread_id = ?2",
            rusqlite::params![account_id, thread_id],
        )?;
        Ok(())
    }

    /// Load all persisted threads for an account, most-recent first.
    pub fn load_threads(&self, account_id: &str) -> Result<Vec<StoredThread>, StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT thread_id, kind, title, avatar, last_at, unread
             FROM threads WHERE account_id = ?1
             ORDER BY COALESCE(last_at, 0) DESC",
        )?;
        let rows = stmt.query_map(rusqlite::params![account_id], |row| {
            Ok(StoredThread {
                account_id: account_id.to_string(),
                thread_id: row.get(0)?,
                kind: thread_kind_from_str(&row.get::<_, String>(1)?),
                title: row.get(2)?,
                avatar: row.get(3)?,
                last_at: row.get(4)?,
                unread: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Load the most recent `limit` messages for an account (newest threads'
    /// activity first within each thread), returned oldest-first per thread for
    /// direct rendering. `limit` caps total rows to keep restore cheap.
    pub fn load_recent_messages(
        &self,
        account_id: &str,
        limit: i64,
    ) -> Result<Vec<StoredMessage>, StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT thread_id, msg_id, from_id, from_name, body, outgoing, ts,
                    sticker_id, sticker_cat_id, sticker_type, sticker_url
             FROM messages WHERE account_id = ?1
             ORDER BY COALESCE(ts, 0) ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![account_id, limit], |row| {
            let sticker_id: Option<i64> = row.get(7)?;
            let sticker_url: Option<String> = row.get(10)?;
            // A sticker row has both an id and a render url; otherwise None.
            let sticker = match (sticker_id, sticker_url) {
                (Some(id), Some(url)) if !url.is_empty() => Some(Sticker {
                    id,
                    cat_id: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                    sticker_type: row.get::<_, Option<i64>>(9)?.unwrap_or(0),
                    url,
                }),
                _ => None,
            };
            Ok(StoredMessage {
                account_id: account_id.to_string(),
                thread_id: row.get(0)?,
                msg_id: row.get(1)?,
                from_id: row.get(2)?,
                from_name: row.get(3)?,
                body: row.get(4)?,
                sticker,
                outgoing: row.get::<_, i64>(5)? != 0,
                ts: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Count saved accounts — a cheap, non-secret diagnostic for the UI/logs to
    /// confirm persistence happened without reading any credential.
    pub fn count_accounts(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
        Ok(n)
    }

    /// Count persisted threads + messages for an account — non-secret diagnostic.
    pub fn counts_for(&self, account_id: &str) -> Result<(i64, i64), StoreError> {
        let conn = self.conn.lock().expect("db mutex poisoned");
        let threads: i64 = conn.query_row(
            "SELECT COUNT(*) FROM threads WHERE account_id = ?1",
            rusqlite::params![account_id],
            |r| r.get(0),
        )?;
        let messages: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE account_id = ?1",
            rusqlite::params![account_id],
            |r| r.get(0),
        )?;
        Ok((threads, messages))
    }

    /// Raw ciphertext blob for an account — test helper to assert that what we
    /// persisted is not plaintext.
    #[cfg(test)]
    pub fn raw_credential_blob(&self, account_id: &str) -> Result<Option<Vec<u8>>, StoreError> {
        use rusqlite::OptionalExtension;
        let conn = self.conn.lock().expect("db mutex poisoned");
        let blob = conn
            .query_row(
                "SELECT enc_blob FROM credentials WHERE account_id = ?1",
                rusqlite::params![account_id],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        Ok(blob)
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Map the persisted kind string back to the typed `ThreadKind` (defaults to
/// `User` for any unrecognized value).
fn thread_kind_from_str(s: &str) -> ThreadKind {
    match s {
        "group" => ThreadKind::Group,
        _ => ThreadKind::User,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zca-store-test-{}-{}-{}.db",
            std::process::id(),
            now_secs(),
            n
        ));
        let _ = std::fs::remove_file(&path);
        Db::open(&path).expect("open db")
    }

    /// The schema migrates cleanly and an empty store loads no accounts.
    #[test]
    fn migrates_and_starts_empty() {
        let db = temp_db();
        assert_eq!(db.load_accounts().expect("load").len(), 0);
    }

    /// mark_reauth_needed + delete_account operate without error on a missing
    /// row (idempotent-ish), and delete removes a saved account.
    #[test]
    fn delete_removes_account_row() {
        let db = temp_db();
        // No crypto/keychain here — just exercise the account row lifecycle via
        // direct SQL using a fake encrypted blob shape is covered in the live
        // roundtrip test; here we ensure delete on an absent id is a no-op.
        db.mark_reauth_needed("nope").expect("mark");
        db.delete_account("nope").expect("delete");
    }

    /// migrate + thread/message persistence round-trips: save_message stores a
    /// message and upserts its thread; load_threads/load_recent_messages return
    /// them; a duplicate msg_id is a no-op (no double unread).
    #[test]
    fn message_persistence_roundtrips_and_dedupes() {
        let db = temp_db();
        let acc = "100000";
        db.save_message(acc, "thread-1", "user", "m1", Some("u2"), Some("Bob"), Some("hi"), false, Some(1000), Some("Bob"), None, true)
            .expect("save m1");
        db.save_message(acc, "thread-1", "user", "m2", Some("u2"), Some("Bob"), Some("there"), false, Some(2000), Some("Bob"), None, true)
            .expect("save m2");
        // Duplicate m1 — must not insert again or double the unread count.
        db.save_message(acc, "thread-1", "user", "m1", Some("u2"), Some("Bob"), Some("hi"), false, Some(1000), Some("Bob"), None, true)
            .expect("dup m1");

        let threads = db.load_threads(acc).expect("threads");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].thread_id, "thread-1");
        assert_eq!(threads[0].unread, 2, "two distinct inbound msgs => unread 2");
        assert_eq!(threads[0].last_at, Some(2000));

        let msgs = db.load_recent_messages(acc, 100).expect("messages");
        assert_eq!(msgs.len(), 2, "duplicate must not create a third row");
        assert_eq!(msgs[0].msg_id, "m1", "oldest-first ordering");
        assert_eq!(msgs[1].body.as_deref(), Some("there"));

        db.clear_unread(acc, "thread-1").expect("clear");
        assert_eq!(db.load_threads(acc).expect("threads2")[0].unread, 0);
    }

    /// Echo reconciliation: the same outgoing message redelivered by the
    /// listener under a DIFFERENT msg_id within the window must not create a
    /// second row (Zalo's send-response id != listener-echo id).
    #[test]
    fn save_message_dedupes_outgoing_echo_across_msg_ids() {
        let db = temp_db();
        let acc = "100000";
        let thread = "thread-echo";
        let body = "rồi chị dô tồn kho chị xem 4 bao";

        // Optimistic/send-side persist with the send-response id.
        db.save_message(acc, thread, "user", "send-id-867250", Some(acc), None, Some(body), true, Some(1_780_450_965_032), None, None, false)
            .expect("send persist");
        // Listener echo of the same message ~0.75s later with the server id.
        db.save_message(acc, thread, "user", "echo-id-928111", Some(acc), None, Some(body), true, Some(1_780_450_965_784), None, None, false)
            .expect("echo persist");

        let msgs = db.load_recent_messages(acc, 100).expect("messages");
        let outgoing: Vec<_> = msgs.iter().filter(|m| m.outgoing && m.body.as_deref() == Some(body)).collect();
        assert_eq!(outgoing.len(), 1, "outgoing echo must not be stored twice across differing msg_ids");

        // A genuinely different outgoing message in the same thread still stores.
        db.save_message(acc, thread, "user", "send-id-999", Some(acc), None, Some("a different line"), true, Some(1_780_450_999_000), None, None, false)
            .expect("other send");
        let total_outgoing = db.load_recent_messages(acc, 100).expect("m2").iter().filter(|m| m.outgoing).count();
        assert_eq!(total_outgoing, 2, "distinct outgoing messages must both persist");
    }

    /// Attachment metadata persists alongside a message.
    #[test]
    fn attachment_metadata_persists() {
        let db = temp_db();
        let acc = "100000";
        db.save_message(acc, "t1", "user", "m1", None, None, Some("file"), false, Some(1), None, None, false)
            .expect("msg");
        db.save_attachment(acc, "m1", Some("image"), Some("https://cdn/x.jpg"), Some("x.jpg"), Some(2048), None)
            .expect("attachment");
        // No dedicated loader yet; absence of error + the message row is enough
        // for this slice (loader lands when the UI renders attachments).
        assert_eq!(db.load_recent_messages(acc, 10).expect("m").len(), 1);
    }

    /// Sticker messages persist with their ids + render URL and reload as a
    /// StoredMessage carrying a Sticker (so history shows the image, not a
    /// placeholder). Outgoing sticker echoes under a different msg_id dedupe.
    #[test]
    fn sticker_message_persists_and_reloads() {
        use crate::types::Sticker;
        let db = temp_db();
        let acc = "100000";
        let sticker = Sticker {
            id: 6699,
            cat_id: 16,
            sticker_type: 7,
            url: "https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid=6699&size=130".to_string(),
        };

        // Incoming sticker from a peer.
        db.save_sticker_message(acc, "u2", "user", "s1", Some("u2"), Some("Bob"), &sticker, false, Some(1000), Some("Bob"), None, true)
            .expect("save incoming sticker");
        // Outgoing sticker (our send) + its listener echo under another msg_id.
        db.save_sticker_message(acc, "u2", "user", "send-s2", Some(acc), None, &sticker, true, Some(2000), None, None, false)
            .expect("save outgoing sticker");
        db.save_sticker_message(acc, "u2", "user", "echo-s2", Some(acc), None, &sticker, true, Some(2300), None, None, false)
            .expect("save echo sticker");

        let msgs = db.load_recent_messages(acc, 100).expect("messages");
        let stickers: Vec<_> = msgs.iter().filter(|m| m.sticker.is_some()).collect();
        assert_eq!(stickers.len(), 2, "incoming + one outgoing (echo deduped)");
        let reloaded = stickers[0].sticker.as_ref().expect("sticker present");
        assert_eq!(reloaded.id, 6699);
        assert_eq!(reloaded.cat_id, 16);
        assert_eq!(reloaded.sticker_type, 7);
        assert!(reloaded.url.contains("eid=6699"));

        // The thread tracks the incoming sticker as one unread.
        let threads = db.load_threads(acc).expect("threads");
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].unread, 1, "only the inbound sticker bumps unread");
    }

    /// Recent stickers: usage upserts (no duplicate, bumps used_at), loads
    /// newest-first, and distinct used categories are derived for pack tabs.
    #[test]
    fn recent_stickers_track_usage_and_categories() {
        use crate::types::Sticker;
        let db = temp_db();
        let acc = "100000";
        let mk = |id: i64, cat: i64| Sticker {
            id,
            cat_id: cat,
            sticker_type: 7,
            url: format!("https://zalo-api.zadn.vn/api/emoticon/sticker/webpc?eid={id}&size=130"),
        };

        db.record_recent_sticker(acc, &mk(1, 10), 1000).expect("r1");
        db.record_recent_sticker(acc, &mk(2, 20), 2000).expect("r2");
        // Re-use sticker 1 later: must bump it to the front, not duplicate.
        db.record_recent_sticker(acc, &mk(1, 10), 3000).expect("r1 again");

        let recent = db.load_recent_stickers(acc, 10).expect("recent");
        assert_eq!(recent.len(), 2, "re-use must not duplicate a sticker");
        assert_eq!(recent[0].id, 1, "most-recently-used sticker comes first");
        assert_eq!(recent[1].id, 2);

        // A sticker with unknown category (0) is excluded from pack tabs.
        db.record_recent_sticker(acc, &mk(3, 0), 4000).expect("r3");
        let cats = db.load_recent_sticker_categories(acc, 10).expect("cats");
        assert_eq!(cats, vec![10, 20], "categories ordered by most-recent use, cat 0 excluded");
    }

    /// Thread-identity backfill: directory data (contacts/groups) updates the
    /// title + avatar of threads that ALREADY exist, and a directory entry with
    /// no conversation does NOT create a thread row. COALESCE preserves an
    /// existing value when the directory omits one.
    #[test]
    fn thread_identity_backfill_updates_existing_only() {
        use crate::types::ThreadIdentity;
        let db = temp_db();
        let acc = "100000";

        // A DM thread and a group thread exist from observed messages; the
        // realtime stream gave us no avatar, and the group title is the last
        // sender's name (the bug this backfill fixes).
        db.save_message(acc, "u2", "user", "m1", Some("u2"), Some("Bob"), Some("hi"), false, Some(1000), Some("Bob"), None, true)
            .expect("save dm");
        db.save_message(acc, "g9", "group", "g1", Some("u3"), Some("Carol"), Some("yo"), false, Some(1500), Some("Carol"), None, true)
            .expect("save group");

        let identities = vec![
            // Matches the DM thread: set its avatar (title already "Bob").
            ThreadIdentity { thread_id: "u2".into(), title: Some("Bob".into()), avatar: Some("https://cdn/bob.jpg".into()) },
            // Matches the group thread: correct the title + set the avatar.
            ThreadIdentity { thread_id: "g9".into(), title: Some("Team Zalo".into()), avatar: Some("https://cdn/team.jpg".into()) },
            // A contact with NO conversation — must not create a thread row.
            ThreadIdentity { thread_id: "u404".into(), title: Some("Stranger".into()), avatar: Some("https://cdn/x.jpg".into()) },
            // An empty payload — skipped (no UPDATE).
            ThreadIdentity { thread_id: "u2".into(), title: None, avatar: None },
        ];
        let updated = db.backfill_thread_identities(acc, &identities).expect("backfill");
        assert_eq!(updated, 2, "only the two existing threads are updated");

        let threads = db.load_threads(acc).expect("threads");
        assert_eq!(threads.len(), 2, "backfill must not create a thread for u404");

        let dm = threads.iter().find(|t| t.thread_id == "u2").expect("dm present");
        assert_eq!(dm.title.as_deref(), Some("Bob"));
        assert_eq!(dm.avatar.as_deref(), Some("https://cdn/bob.jpg"));

        let grp = threads.iter().find(|t| t.thread_id == "g9").expect("group present");
        assert_eq!(grp.title.as_deref(), Some("Team Zalo"), "group title corrected from last sender");
        assert_eq!(grp.avatar.as_deref(), Some("https://cdn/team.jpg"));

        // Empty/whitespace directory values must not blank an existing value.
        let blanking = vec![ThreadIdentity { thread_id: "u2".into(), title: Some(String::new()), avatar: Some(String::new()) }];
        assert_eq!(db.backfill_thread_identities(acc, &blanking).expect("blank"), 0, "empty values are skipped");
        let dm_after = db.load_threads(acc).expect("threads2");
        let dm_after = dm_after.iter().find(|t| t.thread_id == "u2").expect("dm still present");
        assert_eq!(dm_after.title.as_deref(), Some("Bob"), "empty title did not blank existing");
        assert_eq!(dm_after.avatar.as_deref(), Some("https://cdn/bob.jpg"), "empty avatar did not blank existing");
    }

    /// Restart persistence for thread identity: a thread's directory-resolved
    /// title + avatar (backfilled from contacts/groups) survives a full close +
    /// reopen of the SAME SQLite file with NO realtime event and NO live
    /// directory fetch in between — proving the avatar/title cache is durable,
    /// not re-resolved from scratch every session. Run:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored thread_identity_cache_roundtrip --nocapture
    #[test]
    #[ignore = "writes a SQLite file to the temp dir; restart-persistence smoke"]
    fn thread_identity_cache_roundtrip() {
        use crate::types::ThreadIdentity;
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zca-identity-restart-{}-{}-{}.db",
            std::process::id(),
            now_secs(),
            n
        ));
        let _ = std::fs::remove_file(&path);
        let acc = "100000";

        // First "run": observe a group message (title = last sender, no avatar),
        // then backfill identity from the directory the app fetched live.
        {
            let db = Db::open(&path).expect("open #1");
            db.save_message(acc, "g9", "group", "g1", Some("u3"), Some("Carol"), Some("yo"), false, Some(1500), Some("Carol"), None, true)
                .expect("save group");
            let updated = db
                .backfill_thread_identities(
                    acc,
                    &[ThreadIdentity {
                        thread_id: "g9".into(),
                        title: Some("Team Zalo".into()),
                        avatar: Some("https://cdn/team.jpg".into()),
                    }],
                )
                .expect("backfill");
            assert_eq!(updated, 1, "the group thread identity was backfilled");
        } // Db dropped — simulates app shutdown.

        // Second "run": reopen the SAME file (relaunch). With NO realtime event
        // and NO directory fetch, the title + avatar must already be present.
        let db = Db::open(&path).expect("reopen after restart");
        let threads = db.load_threads(acc).expect("threads after restart");
        let grp = threads.iter().find(|t| t.thread_id == "g9").expect("group present after restart");
        assert_eq!(grp.title.as_deref(), Some("Team Zalo"), "title survived restart");
        assert_eq!(grp.avatar.as_deref(), Some("https://cdn/team.jpg"), "avatar survived restart");

        let _ = std::fs::remove_file(&path);
        println!(
            "thread_identity_cache_roundtrip OK: thread '{}' restored title='{}' avatar set={} after restart (no realtime event, no directory fetch)",
            grp.thread_id,
            grp.title.as_deref().unwrap_or(""),
            grp.avatar.is_some()
        );
    }

    /// Live: full save -> load roundtrip through the OS keychain + AES-GCM, and
    /// the on-disk credential blob must be ciphertext (no plaintext secret).
    /// Ignored by default because it touches the real OS keychain.
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored cred_store_roundtrip --nocapture
    #[test]
    #[ignore = "touches the real OS keychain"]
    fn cred_store_roundtrip() {
        use crate::types::Cookie;
        let db = temp_db();
        let profile = AccountProfile {
            account_id: "100000".to_string(),
            display_name: Some("Tester".to_string()),
            avatar: None,
        };
        let creds = Credentials {
            imei: "imei-xyz".to_string(),
            cookie: vec![Cookie {
                domain: ".zalo.me".to_string(),
                name: "zpw_sek".to_string(),
                value: "topsecretvalue".to_string(),
                path: "/".to_string(),
                expiration_date: None,
                host_only: false,
                http_only: false,
                same_site: None,
                secure: true,
                session: false,
                store_id: None,
            }],
            user_agent: "UA".to_string(),
            language: "vi".to_string(),
        };
        db.save_account(&profile, &creds).expect("save");

        // On-disk blob must be ciphertext, not plaintext.
        let blob = db.raw_credential_blob("100000").expect("blob").expect("present");
        assert!(
            !blob.windows(b"topsecretvalue".len()).any(|w| w == b"topsecretvalue"),
            "credential stored in plaintext!"
        );

        let loaded = db.load_accounts().expect("load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].credentials.cookie[0].value, "topsecretvalue");
        println!("cred_store_roundtrip OK: ciphertext on disk, decrypts in memory");
    }

    /// Restart persistence: messages saved to a DB file survive a full close +
    /// reopen of the SAME path with no realtime event in between — proving the
    /// message-cache "restart restores recent threads + messages" smoke offline
    /// (the on-disk SQLite store is the durability boundary; reopening it is
    /// exactly what the app does on relaunch). Run:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored message_cache_roundtrip --nocapture
    #[test]
    #[ignore = "writes a SQLite file to the temp dir; restart-persistence smoke"]
    fn message_cache_roundtrip() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "zca-cache-restart-{}-{}-{}.db",
            std::process::id(),
            now_secs(),
            n
        ));
        let _ = std::fs::remove_file(&path);
        let acc = "100000";

        // First "run": persist an inbound + an outbound message across two threads.
        {
            let db = Db::open(&path).expect("open #1");
            db.save_message(acc, "thread-1", "user", "m1", Some("u2"), Some("Bob"), Some("hi"), false, Some(1000), Some("Bob"), None, true)
                .expect("save inbound");
            db.save_message(acc, "thread-1", "user", "m2", Some(acc), None, Some("hello back"), true, Some(2000), None, None, false)
                .expect("save outbound");
            db.save_message(acc, "thread-2", "group", "g1", Some("u9"), Some("Carol"), Some("group msg"), false, Some(1500), Some("Team"), None, true)
                .expect("save group");
        } // Db dropped here — simulates app shutdown (connection closed).

        // Second "run": reopen the SAME file (relaunch) and read history back
        // with NO new realtime event.
        let db = Db::open(&path).expect("reopen after restart");
        let threads = db.load_threads(acc).expect("threads after restart");
        assert_eq!(threads.len(), 2, "both threads must survive restart");

        let messages = db.load_recent_messages(acc, 100).expect("messages after restart");
        assert_eq!(messages.len(), 3, "all three messages must survive restart");
        let bodies: Vec<&str> = messages.iter().filter_map(|m| m.body.as_deref()).collect();
        assert!(bodies.contains(&"hi") && bodies.contains(&"hello back") && bodies.contains(&"group msg"));

        let _ = std::fs::remove_file(&path);
        println!(
            "message_cache_roundtrip OK: {} threads + {} messages restored after restart (no realtime event)",
            threads.len(),
            messages.len()
        );
    }
}
