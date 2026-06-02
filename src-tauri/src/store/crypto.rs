//! Credential encryption-at-rest (`store` layer, ADR-0005).
//!
//! The credential triple is serialized to JSON, then sealed with AES-256-GCM
//! under a master key that lives ONLY in the OS keychain. The on-disk blob is
//! `nonce(12) || ciphertext`, stored in SQLite as ciphertext — never plaintext.
//!
//! `keyring` and `aes-gcm` are confined to this module so higher layers never
//! see them.

use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;

use crate::types::Credentials;

/// Keychain coordinates for the single master key (ADR-0005 §2).
const KEYRING_SERVICE: &str = "com.zca-desktop.master-key";
const KEYRING_ACCOUNT: &str = "credential-master-key";
const KEY_LEN: usize = 32; // AES-256
const NONCE_LEN: usize = 12; // GCM standard nonce

/// Errors from the credential cipher. Messages never include key/token values.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("keychain access failed")]
    Keychain,
    #[error("master key is malformed")]
    BadKey,
    #[error("credential encryption failed")]
    Encrypt,
    #[error("credential decryption failed (wrong key or corrupt data)")]
    Decrypt,
    #[error("credential serialization failed: {0}")]
    Serde(String),
}

/// Load the master key from the OS keychain, generating + storing one on first
/// use. The key is the only secret kept in the keychain.
fn master_key() -> Result<[u8; KEY_LEN], CryptoError> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|_| CryptoError::Keychain)?;

    match entry.get_secret() {
        Ok(bytes) => {
            let arr: [u8; KEY_LEN] = bytes.as_slice().try_into().map_err(|_| CryptoError::BadKey)?;
            Ok(arr)
        }
        Err(keyring::Error::NoEntry) => {
            // First run: generate a fresh 32-byte key and persist it.
            let mut key = [0u8; KEY_LEN];
            OsRng.fill_bytes(&mut key);
            entry.set_secret(&key).map_err(|_| CryptoError::Keychain)?;
            Ok(key)
        }
        Err(_) => Err(CryptoError::Keychain),
    }
}

/// Encrypt the credential triple into a `nonce || ciphertext` blob for storage.
pub fn encrypt_credentials(credentials: &Credentials) -> Result<Vec<u8>, CryptoError> {
    let key = master_key()?;
    let plaintext = serde_json::to_vec(credentials).map_err(|e| CryptoError::Serde(e.to_string()))?;
    seal(&key, &plaintext)
}

/// Decrypt a stored blob back into the credential triple.
pub fn decrypt_credentials(blob: &[u8]) -> Result<Credentials, CryptoError> {
    let key = master_key()?;
    let plaintext = open(&key, blob)?;
    serde_json::from_slice(&plaintext).map_err(|e| CryptoError::Serde(e.to_string()))
}

/// AES-256-GCM seal with a random nonce; returns `nonce || ciphertext`.
fn seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|_| CryptoError::Encrypt)?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// AES-256-GCM open of a `nonce || ciphertext` blob.
fn open(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if blob.len() < NONCE_LEN {
        return Err(CryptoError::Decrypt);
    }
    let (nonce_bytes, ciphertext) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher.decrypt(nonce, ciphertext).map_err(|_| CryptoError::Decrypt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Cookie;

    fn sample() -> Credentials {
        Credentials {
            imei: "test-imei-abc".to_string(),
            cookie: vec![Cookie {
                domain: ".zalo.me".to_string(),
                name: "zpw_sek".to_string(),
                value: "supersecret".to_string(),
                path: "/".to_string(),
                expiration_date: None,
                host_only: false,
                http_only: false,
                same_site: None,
                secure: true,
                session: false,
                store_id: None,
            }],
            user_agent: "Mozilla/5.0 (Test)".to_string(),
            language: "vi".to_string(),
        }
    }

    /// seal/open round-trip with a fixed key (no keychain needed). Ciphertext
    /// must not contain the plaintext secret, and a wrong key must fail.
    #[test]
    fn seal_open_roundtrip_and_rejects_wrong_key() {
        let key = [7u8; KEY_LEN];
        let plaintext = b"zpw_sek=supersecret; imei=test-imei-abc";
        let blob = seal(&key, plaintext).expect("seal");
        assert!(blob.len() > NONCE_LEN, "blob carries nonce + ciphertext");
        // Ciphertext must not leak the plaintext.
        assert!(
            !blob.windows(b"supersecret".len()).any(|w| w == b"supersecret"),
            "plaintext leaked into ciphertext"
        );
        let opened = open(&key, &blob).expect("open with correct key");
        assert_eq!(opened, plaintext);

        let wrong = [9u8; KEY_LEN];
        assert!(open(&wrong, &blob).is_err(), "wrong key must not decrypt");
    }

    /// A truncated blob (shorter than a nonce) is rejected rather than panicking.
    #[test]
    fn open_rejects_truncated_blob() {
        let key = [1u8; KEY_LEN];
        assert!(open(&key, b"short").is_err());
    }

    /// JSON serialization of the credential triple round-trips through seal/open
    /// with a fixed key, proving the encode/decode path (independent of keychain).
    #[test]
    fn credentials_json_roundtrips_through_cipher() {
        let key = [42u8; KEY_LEN];
        let creds = sample();
        let plaintext = serde_json::to_vec(&creds).unwrap();
        let blob = seal(&key, &plaintext).unwrap();
        let opened = open(&key, &blob).unwrap();
        let back: Credentials = serde_json::from_slice(&opened).unwrap();
        assert_eq!(back.imei, creds.imei);
        assert_eq!(back.cookie.len(), 1);
        assert_eq!(back.cookie[0].name, "zpw_sek");
    }
}
