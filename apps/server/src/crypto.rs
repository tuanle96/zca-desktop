use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

pub fn random_token(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    OsRng.fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

pub fn token_hash(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn generate_data_key() -> [u8; KEY_LEN] {
    let mut key = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key);
    key
}

/// Fixed application salt for HKDF key derivation. Combined with a distinct `info`
/// string per purpose, this provides domain separation and a real KDF instead of a
/// bare unsalted hash.
///
/// BREAKING: changing this salt, the `info` strings, or this scheme makes every
/// existing wrapped data key — and therefore all stored ciphertext — unreadable.
const HKDF_SALT: &[u8] = b"zca-cloud-hkdf-salt-v1";

fn derive_key_hkdf(ikm: &[u8], info: &[u8]) -> [u8; KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), ikm);
    let mut okm = [0u8; KEY_LEN];
    hk.expand(info, &mut okm)
        .expect("KEY_LEN is a valid HKDF-SHA256 output length");
    okm
}

pub fn derive_recovery_key(recovery_key: &str) -> [u8; KEY_LEN] {
    derive_key_hkdf(recovery_key.as_bytes(), b"zca-cloud:recovery-key-wrap:v1")
}

pub fn derive_server_key(master_key_seed: &str) -> [u8; KEY_LEN] {
    derive_key_hkdf(master_key_seed.as_bytes(), b"zca-cloud:server-key-wrap:v1")
}

pub fn hash_recovery_key(recovery_key: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(recovery_key.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| AppError::Crypto)
}

pub fn verify_recovery_key(hash: &str, recovery_key: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(recovery_key.as_bytes(), &parsed)
        .is_ok()
}

pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8]) -> AppResult<(Vec<u8>, Vec<u8>)> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|_| AppError::Crypto)?;
    Ok((nonce_bytes.to_vec(), ciphertext))
}

pub fn open(key: &[u8; KEY_LEN], nonce: &[u8], ciphertext: &[u8]) -> AppResult<Vec<u8>> {
    if nonce.len() != NONCE_LEN {
        return Err(AppError::Crypto);
    }
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| AppError::Crypto)
}

pub fn wrap_data_key(
    recovery_key: &str,
    data_key: &[u8; KEY_LEN],
) -> AppResult<(Vec<u8>, Vec<u8>)> {
    seal(&derive_recovery_key(recovery_key), data_key)
}

pub fn unwrap_data_key(
    recovery_key: &str,
    nonce: &[u8],
    wrapped: &[u8],
) -> AppResult<[u8; KEY_LEN]> {
    let plaintext = open(&derive_recovery_key(recovery_key), nonce, wrapped)?;
    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Crypto)
}

pub fn wrap_data_key_for_server(
    master_key_seed: &str,
    data_key: &[u8; KEY_LEN],
) -> AppResult<(Vec<u8>, Vec<u8>)> {
    seal(&derive_server_key(master_key_seed), data_key)
}

pub fn unwrap_data_key_for_server(
    master_key_seed: &str,
    nonce: &[u8],
    wrapped: &[u8],
) -> AppResult<[u8; KEY_LEN]> {
    let plaintext = open(&derive_server_key(master_key_seed), nonce, wrapped)?;
    plaintext
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Crypto)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_hides_plaintext() {
        let key = generate_data_key();
        let body = b"secret message body";
        let (nonce, ciphertext) = seal(&key, body).unwrap();
        assert!(!ciphertext.windows(b"secret".len()).any(|w| w == b"secret"));
        let back = open(&key, &nonce, &ciphertext).unwrap();
        assert_eq!(back, body);
    }

    #[test]
    fn token_hash_is_stable_and_not_plaintext() {
        let token = "magic-token";
        let hash = token_hash(token);
        assert_eq!(hash, token_hash(token));
        assert_ne!(hash, token);
    }

    #[test]
    fn recovery_key_hash_and_wrap_roundtrip() {
        let recovery = "zca_recovery_test";
        let hash = hash_recovery_key(recovery).unwrap();
        assert!(verify_recovery_key(&hash, recovery));
        assert!(!verify_recovery_key(&hash, "wrong"));
        let key = generate_data_key();
        let (nonce, wrapped) = wrap_data_key(recovery, &key).unwrap();
        assert_eq!(unwrap_data_key(recovery, &nonce, &wrapped).unwrap(), key);
        let (server_nonce, server_wrapped) =
            wrap_data_key_for_server("server-master", &key).unwrap();
        assert_eq!(
            unwrap_data_key_for_server("server-master", &server_nonce, &server_wrapped).unwrap(),
            key
        );
    }
}
