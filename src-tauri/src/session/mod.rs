//! `session` layer — owns the set of concurrent per-account Zalo sessions.
//!
//! ADR-0003 layer order: `types → config → store → zalo → session → command`.
//! This layer sits above `zalo` and below `command`. It holds one
//! [`ManagedSession`] per logged-in account (the authenticated API facade plus
//! its live realtime [`Listener`]) and owns their lifecycle:
//!
//! - **add / replace (restart):** [`SessionManager::insert`] registers a new
//!   session and, if one already exists for the account, gracefully stops the
//!   previous listener first so its websocket is not leaked.
//! - **remove:** [`SessionManager::remove`] stops the listener and drops it.
//! - **send throttle:** [`SessionManager::send_text`] spaces outbound messages
//!   per account by at least [`DEFAULT_SEND_INTERVAL`] so the client cannot
//!   behave in a spam-like way (project risk r1, ban risk).
//!
//! The realtime listener type is abstracted behind the [`MessageListener`]
//! trait so the manager's lifecycle logic is unit-testable without a live
//! session, and so `zca-rust`'s concrete `Listener` stays reachable only
//! through the `zalo` layer.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::types::AccountId;
use crate::zalo::{ZaloError, API};

/// Minimum spacing between two sends on the *same* account. Outbound messages
/// for an account are scheduled at least this far apart; different accounts are
/// throttled independently. Personal-use pacing to avoid spam-like bursts
/// (project risk r1) — not a hard quota.
pub const DEFAULT_SEND_INTERVAL: Duration = Duration::from_millis(800);

/// Anything that owns a realtime listener socket and can be shut down.
///
/// Implemented for the `zalo` layer's `Listener` so the manager can stop a
/// session's socket on replace/remove. Defined here (not in `zalo`) so the
/// manager depends on this seam rather than on `zca-rust`'s concrete type, and
/// so tests can substitute a fake listener.
pub trait MessageListener: Send + 'static {
    /// Signal the listener to stop; the underlying socket is closed.
    fn stop(&mut self);
}

impl MessageListener for crate::zalo::Listener {
    fn stop(&mut self) {
        crate::zalo::Listener::stop(self);
    }
}

/// Errors surfaced by session operations. The `command` layer maps these to
/// plain UI strings; no secret values are ever included.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// No session is registered for the given account (log in first).
    #[error("no active session for account {0}; log in first")]
    NotFound(AccountId),
    /// The underlying `zalo`/`zca-rust` call failed.
    #[error(transparent)]
    Zalo(#[from] ZaloError),
}

/// One managed account: its handle (the authenticated API) plus the live
/// listener kept alive for the session's lifetime.
struct ManagedSession<H> {
    handle: H,
    listener: Box<dyn MessageListener>,
}

/// Per-account send pacing. Tracks the earliest `Instant` each account is next
/// allowed to send and hands out the wait a caller must observe before sending.
struct SendThrottle {
    interval: Duration,
    next_allowed: Mutex<HashMap<AccountId, Instant>>,
}

impl SendThrottle {
    fn new(interval: Duration) -> Self {
        Self { interval, next_allowed: Mutex::new(HashMap::new()) }
    }

    /// Reserve the next send slot for `account_id` relative to `now`, returning
    /// how long the caller must wait before sending. Updates the schedule so
    /// back-to-back reservations are spaced by at least `interval`. `now` is a
    /// parameter so the logic is deterministically testable.
    async fn reserve(&self, account_id: &AccountId, now: Instant) -> Duration {
        let mut map = self.next_allowed.lock().await;
        // The slot opens no earlier than the previously scheduled time, and
        // never in the past.
        let scheduled = map.get(account_id).copied().unwrap_or(now).max(now);
        let wait = scheduled.saturating_duration_since(now);
        map.insert(account_id.clone(), scheduled + self.interval);
        wait
    }

    /// Forget an account's pacing state (called when its session is removed).
    async fn forget(&self, account_id: &AccountId) {
        self.next_allowed.lock().await.remove(account_id);
    }
}

/// Owns N concurrent per-account sessions keyed by [`AccountId`].
///
/// Generic over the session handle `H` (defaults to `Arc<API>`, the real
/// authenticated client). The generic parameter exists so the lifecycle
/// (add/replace/remove + listener shutdown) can be unit-tested with a trivial
/// handle; production always uses the default.
pub struct SessionManager<H = Arc<API>> {
    sessions: Mutex<HashMap<AccountId, ManagedSession<H>>>,
    throttle: SendThrottle,
}

impl<H> Default for SessionManager<H> {
    fn default() -> Self {
        Self::new()
    }
}

impl<H> SessionManager<H> {
    /// New manager with the default send interval.
    pub fn new() -> Self {
        Self::with_send_interval(DEFAULT_SEND_INTERVAL)
    }

    /// New manager with a custom per-account send interval (used by tests).
    pub fn with_send_interval(interval: Duration) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            throttle: SendThrottle::new(interval),
        }
    }

    /// Register a session for `account_id`. If one already exists it is treated
    /// as a restart: the previous listener is gracefully stopped before the new
    /// session replaces it, so the old websocket is never leaked.
    pub async fn insert(&self, account_id: AccountId, handle: H, listener: impl MessageListener) {
        let mut map = self.sessions.lock().await;
        if let Some(mut previous) = map.remove(&account_id) {
            previous.listener.stop();
        }
        map.insert(account_id, ManagedSession { handle, listener: Box::new(listener) });
    }

    /// Remove a session, stopping its listener. Returns `true` if one was
    /// present. Also clears the account's send-throttle state.
    pub async fn remove(&self, account_id: &AccountId) -> bool {
        let removed = {
            let mut map = self.sessions.lock().await;
            match map.remove(account_id) {
                Some(mut session) => {
                    session.listener.stop();
                    true
                }
                None => false,
            }
        };
        if removed {
            self.throttle.forget(account_id).await;
        }
        removed
    }

    /// Clone of the handle for `account_id`, if a session is registered.
    pub async fn get(&self, account_id: &AccountId) -> Option<H>
    where
        H: Clone,
    {
        self.sessions.lock().await.get(account_id).map(|s| s.handle.clone())
    }

    /// All currently-managed account ids.
    pub async fn account_ids(&self) -> Vec<AccountId> {
        self.sessions.lock().await.keys().cloned().collect()
    }

    /// Number of active sessions.
    pub async fn count(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

impl SessionManager<Arc<API>> {
    /// Send a plain-text message from `account_id`, honouring the per-account
    /// send throttle, and return the new message id.
    ///
    /// Looks up the authenticated session, reserves a throttle slot (waiting if
    /// the account sent too recently), then delegates the actual send to the
    /// `zalo` layer. Input is expected to be validated by the `command`
    /// boundary before this is called.
    pub async fn send_text(
        &self,
        account_id: &AccountId,
        thread_id: &str,
        text: &str,
    ) -> Result<String, SessionError> {
        self.send_text_with_quote(account_id, thread_id, text, None, crate::types::ThreadKind::User)
            .await
    }

    /// Send a plain-text message or quoted reply from `account_id`, honouring
    /// the per-account send throttle and preserving the destination thread kind.
    pub async fn send_text_with_quote(
        &self,
        account_id: &AccountId,
        thread_id: &str,
        text: &str,
        quote: Option<&crate::types::QuoteInput>,
        kind: crate::types::ThreadKind,
    ) -> Result<String, SessionError> {
        let api = self
            .get(account_id)
            .await
            .ok_or_else(|| SessionError::NotFound(account_id.clone()))?;

        let wait = self.throttle.reserve(account_id, Instant::now()).await;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let msg_id = crate::zalo::send_text_with_quote(&api, thread_id, text, quote, kind).await?;
        Ok(msg_id)
    }

    /// Send a sticker from `account_id`, honouring the per-account send
    /// throttle, and return the new message id.
    ///
    /// Same pacing path as [`send_text`] (ban-risk r1): resolve the session,
    /// reserve a throttle slot, then delegate to the `zalo` layer.
    pub async fn send_sticker(
        &self,
        account_id: &AccountId,
        thread_id: &str,
        sticker: &crate::types::Sticker,
        kind: crate::types::ThreadKind,
    ) -> Result<String, SessionError> {
        let api = self
            .get(account_id)
            .await
            .ok_or_else(|| SessionError::NotFound(account_id.clone()))?;

        let wait = self.throttle.reserve(account_id, Instant::now()).await;
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let msg_id = crate::zalo::send_sticker(&api, thread_id, sticker, kind).await?;
        Ok(msg_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Fake listener that records how many times it was stopped, so lifecycle
    /// tests can assert the manager shuts sockets down on replace/remove.
    struct FakeListener(Arc<AtomicUsize>);

    impl MessageListener for FakeListener {
        fn stop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn counter() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    /// Inserting a second session for the same account is a restart: the prior
    /// listener is stopped exactly once and the handle is replaced.
    #[tokio::test]
    async fn insert_replaces_and_stops_previous_listener() {
        let mgr: SessionManager<u32> = SessionManager::new();
        let first_stops = counter();
        let second_stops = counter();

        mgr.insert("acc".to_string(), 1, FakeListener(first_stops.clone())).await;
        assert_eq!(mgr.get(&"acc".to_string()).await, Some(1));
        assert_eq!(mgr.count().await, 1);

        mgr.insert("acc".to_string(), 2, FakeListener(second_stops.clone())).await;
        assert_eq!(first_stops.load(Ordering::SeqCst), 1, "old listener must be stopped on replace");
        assert_eq!(second_stops.load(Ordering::SeqCst), 0, "new listener must stay running");
        assert_eq!(mgr.get(&"acc".to_string()).await, Some(2), "handle must be replaced");
        assert_eq!(mgr.count().await, 1, "replace must not grow the map");
    }

    /// Removing a session stops its listener and drops it; removing an unknown
    /// account is a no-op.
    #[tokio::test]
    async fn remove_stops_listener_and_reports_presence() {
        let mgr: SessionManager<u32> = SessionManager::new();
        let stops = counter();
        mgr.insert("acc".to_string(), 7, FakeListener(stops.clone())).await;

        assert!(mgr.remove(&"acc".to_string()).await, "present session removed");
        assert_eq!(stops.load(Ordering::SeqCst), 1, "listener stopped on remove");
        assert_eq!(mgr.get(&"acc".to_string()).await, None);
        assert!(!mgr.remove(&"acc".to_string()).await, "removing again is a no-op");
    }

    /// Two accounts are tracked concurrently and listed back.
    #[tokio::test]
    async fn tracks_multiple_accounts_concurrently() {
        let mgr: SessionManager<u32> = SessionManager::new();
        mgr.insert("a".to_string(), 1, FakeListener(counter())).await;
        mgr.insert("b".to_string(), 2, FakeListener(counter())).await;

        let mut ids = mgr.account_ids().await;
        ids.sort();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(mgr.count().await, 2);
        assert_eq!(mgr.get(&"b".to_string()).await, Some(2));
    }

    /// First send is immediate; a same-account back-to-back send must wait one
    /// interval; a different account is unaffected (independent pacing).
    #[tokio::test]
    async fn throttle_spaces_same_account_only() {
        let interval = Duration::from_millis(500);
        let throttle = SendThrottle::new(interval);
        let now = Instant::now();

        let a = "a".to_string();
        let b = "b".to_string();

        assert_eq!(throttle.reserve(&a, now).await, Duration::ZERO, "first send is immediate");

        let second = throttle.reserve(&a, now).await;
        assert_eq!(second, interval, "second same-account send waits one interval");

        let third = throttle.reserve(&a, now).await;
        assert_eq!(third, interval * 2, "third stacks another interval");

        assert_eq!(throttle.reserve(&b, now).await, Duration::ZERO, "other account is independent");
    }

    /// Once enough time has passed, a send is immediate again (no stale debt).
    #[tokio::test]
    async fn throttle_clears_after_interval_elapses() {
        let interval = Duration::from_millis(500);
        let throttle = SendThrottle::new(interval);
        let now = Instant::now();
        let a = "a".to_string();

        assert_eq!(throttle.reserve(&a, now).await, Duration::ZERO);
        // A later reservation past the scheduled slot waits nothing.
        let later = now + interval * 2;
        assert_eq!(throttle.reserve(&a, later).await, Duration::ZERO);
    }

    /// Removing a session forgets its throttle state, so a fresh login does not
    /// inherit a stale wait.
    #[tokio::test]
    async fn remove_clears_throttle_state() {
        let mgr: SessionManager<u32> = SessionManager::with_send_interval(Duration::from_secs(10));
        let now = Instant::now();
        mgr.insert("acc".to_string(), 1, FakeListener(counter())).await;
        // Burn a slot so the account would otherwise owe a wait.
        let _ = mgr.throttle.reserve(&"acc".to_string(), now).await;
        assert!(mgr.throttle.reserve(&"acc".to_string(), now).await > Duration::ZERO);

        mgr.remove(&"acc".to_string()).await;
        // After removal the pacing state is gone: next reserve is immediate.
        assert_eq!(mgr.throttle.reserve(&"acc".to_string(), now).await, Duration::ZERO);
    }

    /// Live multi-account smoke. Ignored by default. Logs in TWO real accounts
    /// concurrently through the SessionManager (account A from `.zalo-cred.json`,
    /// account B from `ZALO_CRED_FILE_2`), starts a realtime listener for each
    /// over a SHARED channel, and asserts:
    ///   1. both sessions are tracked at once (count == 2),
    ///   2. each account, sending with `self_listen`, surfaces its OWN marker
    ///      tagged with its OWN account id (no cross-account leak),
    ///   3. the send goes through SessionManager::send_text (throttled path).
    /// Prints only non-secret diagnostics (uid lengths, msg-id lengths). Run:
    ///   ZALO_CRED_FILE_2=/abs/path/.zalo-cred-2.json \
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored two_accounts_live --nocapture
    #[tokio::test]
    #[ignore = "requires two real accounts (.zalo-cred.json + ZALO_CRED_FILE_2); performs live logins"]
    async fn two_accounts_live() {
        use crate::types::{Credentials, IncomingMessage};
        use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};
        use tokio::sync::mpsc;

        fn load(path: &str) -> Credentials {
            let raw = std::fs::read_to_string(path)
                .unwrap_or_else(|_| panic!("could not read credential file {path}"));
            let creds: Credentials =
                serde_json::from_str(&raw).expect("credential file must be valid Credentials JSON");
            creds.validate().expect("credential file is missing required fields");
            creds
        }

        let path_a = std::env::var("ZALO_CRED_FILE").unwrap_or_else(|_| "../.zalo-cred.json".to_string());
        let path_b = std::env::var("ZALO_CRED_FILE_2")
            .expect("set ZALO_CRED_FILE_2 to a second account's credential file");

        // self_listen=true so each account's own outbound send returns as an
        // inbound websocket event we can match on. Each account sends to the
        // authorized test recipient (resolved by phone); no unrelated third
        // party is contacted.
        let api_a = Arc::new(
            crate::zalo::login_with(load(&path_a), true).await.expect("account A login failed"),
        );
        let api_b = Arc::new(
            crate::zalo::login_with(load(&path_b), true).await.expect("account B login failed"),
        );
        let id_a = api_a.get_own_id().to_string();
        let id_b = api_b.get_own_id().to_string();
        assert_ne!(id_a, id_b, "the two accounts must be distinct");

        // Shared channel: IncomingMessage carries account_id, so one bridge
        // proves per-account tagging.
        let (tx, mut rx) = mpsc::channel::<IncomingMessage>(64);
        let listener_a = crate::zalo::start_message_listener(api_a.clone(), tx.clone())
            .await
            .expect("listener A failed to start");
        let listener_b = crate::zalo::start_message_listener(api_b.clone(), tx)
            .await
            .expect("listener B failed to start");

        let mgr: SessionManager<Arc<API>> = SessionManager::new();
        mgr.insert(id_a.clone(), api_a.clone(), listener_a).await;
        mgr.insert(id_b.clone(), api_b.clone(), listener_b).await;
        assert_eq!(mgr.count().await, 2, "two concurrent sessions must be tracked");

        // Let both sockets complete their cipher handshake.
        tokio::time::sleep(StdDuration::from_secs(3)).await;

        // Resolve the authorized recipient by phone for each account (sending to
        // own uid returns code 114). self_listen surfaces each account's own
        // outbound message as a real inbound event tagged with that account.
        let recipient_phone =
            std::env::var("ZALO_TEST_PHONE").unwrap_or_else(|_| "0359969964".to_string());
        let recipient_a = api_a
            .find_user(&recipient_phone, zca_rust::models::AvatarSize::Small)
            .await
            .expect("account A could not resolve recipient by phone")
            .uid;
        let recipient_b = api_b
            .find_user(&recipient_phone, zca_rust::models::AvatarSize::Small)
            .await
            .expect("account B could not resolve recipient by phone")
            .uid;

        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let marker_a = format!("zca-desktop two-accounts A {stamp}");
        let marker_b = format!("zca-desktop two-accounts B {stamp}");

        // Each account sends via the throttled manager path; self_listen echoes
        // it back tagged with that account's id.
        mgr.send_text(&id_a, &recipient_a, &marker_a).await.expect("account A send failed");
        mgr.send_text(&id_b, &recipient_b, &marker_b).await.expect("account B send failed");

        // Collect until BOTH markers are seen, each tagged with the right account.
        let mut saw_a = false;
        let mut saw_b = false;
        let captured = tokio::time::timeout(StdDuration::from_secs(25), async {
            while let Some(msg) = rx.recv().await {
                if msg.text.as_deref() == Some(marker_a.as_str()) {
                    assert_eq!(msg.account_id, id_a, "marker A tagged with wrong account");
                    saw_a = true;
                } else if msg.text.as_deref() == Some(marker_b.as_str()) {
                    assert_eq!(msg.account_id, id_b, "marker B tagged with wrong account");
                    saw_b = true;
                }
                if saw_a && saw_b {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);

        assert!(captured, "both accounts must surface their own marker within 25s (saw_a={saw_a}, saw_b={saw_b})");

        // Graceful shutdown: removing each session stops its listener.
        assert!(mgr.remove(&id_a).await);
        assert!(mgr.remove(&id_b).await);
        assert_eq!(mgr.count().await, 0, "both sessions removed");

        println!(
            "two_accounts_live OK: 2 concurrent sessions, per-account routing verified (uid_a_len={}, uid_b_len={})",
            id_a.len(),
            id_b.len()
        );
    }

    /// Live single-account smoke through the FULL SessionManager path. Ignored
    /// by default. Proves the new mechanism end-to-end with one real account:
    /// log in (self_listen) -> register in SessionManager -> send via the
    /// THROTTLED `send_text` path to the account's own uid -> the realtime
    /// listener owned by the manager surfaces the marker tagged with the right
    /// account id -> `remove` stops the listener and clears state. This is the
    /// runnable subset of `two_accounts_live` (which additionally needs a second
    /// credential to prove concurrent cardinality). Run:
    ///   cargo test --manifest-path src-tauri/Cargo.toml -- --ignored session_manager_roundtrip_live --nocapture
    #[tokio::test]
    #[ignore = "requires real .zalo-cred.json; performs a live login + send + listen round trip"]
    async fn session_manager_roundtrip_live() {
        use crate::types::{Credentials, IncomingMessage};
        use std::time::{Duration as StdDuration, SystemTime, UNIX_EPOCH};
        use tokio::sync::mpsc;

        let path = std::env::var("ZALO_CRED_FILE").unwrap_or_else(|_| "../.zalo-cred.json".to_string());
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("could not read credential file {path}"));
        let creds: Credentials =
            serde_json::from_str(&raw).expect("credential file must be valid Credentials JSON");
        creds.validate().expect("credential file is missing required fields");

        // self_listen so our own outbound send returns as an inbound event.
        let api = Arc::new(crate::zalo::login_with(creds, true).await.expect("live login failed"));
        let id = api.get_own_id().to_string();

        let (tx, mut rx) = mpsc::channel::<IncomingMessage>(32);
        let listener = crate::zalo::start_message_listener(api.clone(), tx)
            .await
            .expect("listener failed to start");

        let mgr: SessionManager<Arc<API>> = SessionManager::new();
        mgr.insert(id.clone(), api.clone(), listener).await;
        assert_eq!(mgr.count().await, 1, "session must be registered");
        assert!(mgr.get(&id).await.is_some(), "handle must resolve via the manager");

        tokio::time::sleep(StdDuration::from_secs(3)).await;

        // Resolve the authorized test recipient by phone (sending to own uid
        // returns code 114). self_listen surfaces our own outbound message as a
        // real inbound event we can match on.
        let recipient_phone =
            std::env::var("ZALO_TEST_PHONE").unwrap_or_else(|_| "0359969964".to_string());
        let recipient = api
            .find_user(&recipient_phone, zca_rust::models::AvatarSize::Small)
            .await
            .expect("could not resolve test recipient by phone")
            .uid;

        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let marker = format!("zca-desktop session-mgr roundtrip {stamp}");
        // Send via the THROTTLED manager path to the authorized recipient.
        let msg_id = mgr.send_text(&id, &recipient, &marker).await.expect("manager send failed");
        assert!(!msg_id.is_empty(), "send must return a message id");

        let matched = tokio::time::timeout(StdDuration::from_secs(20), async {
            while let Some(msg) = rx.recv().await {
                if msg.text.as_deref() == Some(marker.as_str()) {
                    assert_eq!(msg.account_id, id, "event tagged with wrong account");
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(matched, "manager-owned listener must surface the sent marker within 20s");

        assert!(mgr.remove(&id).await, "remove must stop the listener and report presence");
        assert_eq!(mgr.count().await, 0, "session removed");

        println!(
            "session_manager_roundtrip_live OK: login+register+throttled-send+listen+remove (uid_len={}, msg_id_len={})",
            id.len(),
            msg_id.len()
        );
    }
}
