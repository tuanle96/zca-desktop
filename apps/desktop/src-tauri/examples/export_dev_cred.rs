//! Dev helper: export ONE live credential from the app's local SQLite store
//! into the gitignored `.zalo-cred.json` at the repo root, so the `#[ignore]`
//! live smokes can run against a real session.
//!
//! This reuses the real `store` layer (keychain master key + AES-256-GCM open),
//! so the credential never leaves the machine and the on-disk store stays the
//! single source of truth. It prints ONLY non-secret diagnostics.
//!
//! Run from `src-tauri/`:
//!   cargo run --example export_dev_cred -- <account_id>
//! With no arg it picks the most-recently logged-in account.

use std::path::PathBuf;

use rusqlite::Connection;
use zca_desktop_lib::store::decrypt_credentials;

fn app_db_path() -> PathBuf {
    let home = std::env::var_os("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("zca-desktop")
        .join("zca.db")
}

fn main() {
    let db_path = app_db_path();
    eprintln!("[export] store: {}", db_path.display());

    // Pick the target account: CLI arg, else the most-recent login.
    let arg = std::env::args().nth(1);
    let account_id = match arg {
        Some(id) => id,
        None => {
            let conn = Connection::open(&db_path).expect("open store (read accounts)");
            conn.query_row(
                "SELECT account_id FROM accounts ORDER BY last_login_at DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("no accounts in store")
        }
    };
    eprintln!("[export] account_id_len={}", account_id.len());

    // Read the ciphertext blob directly (the typed accessor is test-only).
    let conn = Connection::open(&db_path).expect("open store (read credential)");
    let blob: Vec<u8> = conn
        .query_row(
            "SELECT enc_blob FROM credentials WHERE account_id = ?1",
            [&account_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .expect("no stored credential for that account");

    let credentials = decrypt_credentials(&blob).expect("decrypt (keychain master key)");

    let json = serde_json::to_string_pretty(&credentials).expect("serialize credentials");
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.zalo-cred.json");
    std::fs::write(&out, json).expect("write .zalo-cred.json");

    eprintln!(
        "[export] wrote {} (cookies={}, imei_len={}, ua_len={}, lang={})",
        out.display(),
        credentials.cookie.len(),
        credentials.imei.len(),
        credentials.user_agent.len(),
        credentials.language
    );
}
