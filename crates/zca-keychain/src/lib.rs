//! Thin OS-keychain wrapper: store / load / delete a secret string under a
//! `(service, account)` pair.
//!
//! Bearer credentials (e.g. the cloud device token) live ONLY here and are never
//! serialized to the webview. Both the desktop and mobile Tauri cores use it.
//!
//! Backends:
//! - macOS / iOS (Security framework), Windows (WinCred), Linux (Secret Service)
//!   via the `keyring` crate.
//! - Android has no `keyring` backend, so we fall back to an **app-private file
//!   store** under `$ZCA_KEYCHAIN_DIR` (set this to the app's data dir; defaults
//!   to a temp dir). App-private storage is sandboxed per-app on Android, though
//!   not hardware-Keystore-backed — that hardening is a future step.

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("keychain access failed")]
    Access,
}

pub type Result<T> = std::result::Result<T, KeychainError>;

// ---- native keychain backend (everything except Android) ----
#[cfg(not(target_os = "android"))]
mod backend {
    use super::{KeychainError, Result};

    fn entry(service: &str, account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(service, account).map_err(|_| KeychainError::Access)
    }

    pub fn store(service: &str, account: &str, secret: &str) -> Result<()> {
        entry(service, account)?
            .set_password(secret)
            .map_err(|_| KeychainError::Access)
    }

    pub fn load(service: &str, account: &str) -> Result<Option<String>> {
        match entry(service, account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(KeychainError::Access),
        }
    }

    pub fn delete(service: &str, account: &str) -> Result<()> {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(KeychainError::Access),
        }
    }
}

// ---- Android backend: app-private file store ----
#[cfg(target_os = "android")]
mod backend {
    use super::Result;

    fn dir() -> std::path::PathBuf {
        std::env::var_os("ZCA_KEYCHAIN_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("zca-keychain"))
    }

    pub fn store(service: &str, account: &str, secret: &str) -> Result<()> {
        super::file_store::store(&dir(), service, account, secret)
    }
    pub fn load(service: &str, account: &str) -> Result<Option<String>> {
        super::file_store::load(&dir(), service, account)
    }
    pub fn delete(service: &str, account: &str) -> Result<()> {
        super::file_store::delete(&dir(), service, account)
    }
}

// File-backed store used by the Android backend. Compiled on all platforms so it
// stays host-testable; only wired in on Android.
#[allow(dead_code)]
mod file_store {
    use super::{KeychainError, Result};
    use std::path::{Path, PathBuf};

    fn key_path(dir: &Path, service: &str, account: &str) -> PathBuf {
        let safe = |s: &str| {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect::<String>()
        };
        dir.join(format!("{}__{}.secret", safe(service), safe(account)))
    }

    pub fn store(dir: &Path, service: &str, account: &str, secret: &str) -> Result<()> {
        std::fs::create_dir_all(dir).map_err(|_| KeychainError::Access)?;
        std::fs::write(key_path(dir, service, account), secret).map_err(|_| KeychainError::Access)
    }

    pub fn load(dir: &Path, service: &str, account: &str) -> Result<Option<String>> {
        match std::fs::read_to_string(key_path(dir, service, account)) {
            Ok(secret) => Ok(Some(secret)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(KeychainError::Access),
        }
    }

    pub fn delete(dir: &Path, service: &str, account: &str) -> Result<()> {
        match std::fs::remove_file(key_path(dir, service, account)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(KeychainError::Access),
        }
    }
}

pub use backend::{delete, load, store};

#[cfg(test)]
mod tests {
    use super::file_store;

    #[test]
    fn file_store_roundtrip_and_missing_is_none() {
        let dir = std::env::temp_dir().join(format!("zca-kc-test-{}", std::process::id()));
        let (svc, acct) = ("app.zca.test", "device-token::http://x");

        assert_eq!(file_store::load(&dir, svc, acct).unwrap(), None);
        file_store::store(&dir, svc, acct, "secret-token").unwrap();
        assert_eq!(
            file_store::load(&dir, svc, acct).unwrap().as_deref(),
            Some("secret-token")
        );
        file_store::delete(&dir, svc, acct).unwrap();
        assert_eq!(file_store::load(&dir, svc, acct).unwrap(), None);
        // delete is idempotent
        file_store::delete(&dir, svc, acct).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
