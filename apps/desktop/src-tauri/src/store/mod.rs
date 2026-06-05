//! `store` layer — local persistence + secrets (ADR-0003 / ADR-0005).
//!
//! Owns the SQLite database (bundled `rusqlite`), the OS-keychain master key
//! (`keyring`), and AES-256-GCM encryption of the credential blob (`aes-gcm`).
//! Higher layers call the typed functions here; `rusqlite`/`keyring`/`aes-gcm`
//! types never leak above this layer.
//!
//! Security (ADR-0005): the credential triple (imei + cookie + user_agent) is a
//! bearer token and is NEVER written in plaintext. Only a single random 32-byte
//! master key lives in the OS keychain; credentials are AES-GCM encrypted with
//! it and stored as ciphertext in SQLite.

pub mod crypto;
pub mod db;

pub use db::{Db, SavedAccount, StoreError};

/// Re-export the credential cipher entry points for the `command` layer.
pub use crypto::{decrypt_credentials, encrypt_credentials, CryptoError};
