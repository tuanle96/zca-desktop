// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Rust core layers (ADR-0003): types → config → store → zalo → session → command.
pub mod command;
pub mod config;
pub mod store;
pub mod types;
pub mod zalo;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logging before anything else so startup is traced. The log dir
    // defaults to the OS app-data dir (falling back to ./logs); the guard must
    // outlive the app, so it is moved into the Tauri setup closure's state.
    let default_log_dir = default_log_dir();
    let cfg = config::Config::from_env(default_log_dir);
    let _log_guard = config::logging::init(&cfg);

    // Open the local SQLite store (ADR-0005). A failure here is non-fatal:
    // the app still runs (QR login works), persistence/restore just no-op.
    let store_state = command::StoreState(open_store());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(command::ListenerState::default())
        .manage(store_state)
        .setup(move |_app| {
            // Keep the file-logging guard alive for the whole app lifetime.
            std::mem::forget(_log_guard);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            command::import_credentials,
            command::login,
            command::start_listening,
            command::start_qr_login,
            command::restore_sessions,
            command::send_message,
            command::list_contacts,
            command::cred_file_summary,
            command::login_from_file,
            command::start_listening_from_file,
            command::log_from_ui
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Open the local SQLite store at `<app-data>/zca-desktop/zca.db`. Returns
/// `None` (logged) if it cannot be opened, so the app degrades gracefully.
fn open_store() -> Option<std::sync::Arc<store::Db>> {
    let dir = dirs_app_data()
        .map(|d| d.join("zca-desktop"))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let path = dir.join("zca.db");
    match store::Db::open(&path) {
        Ok(db) => {
            tracing::info!(db = %path.display(), "local store opened");
            Some(std::sync::Arc::new(db))
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to open local store; persistence disabled");
            None
        }
    }
}

/// Default log directory: `<OS app-data>/zca-desktop/logs`, falling back to
/// `./logs` relative to the working dir when no home/app-data dir is available.
fn default_log_dir() -> std::path::PathBuf {
    if let Some(dir) = dirs_app_data() {
        return dir.join("zca-desktop").join("logs");
    }
    std::path::PathBuf::from("logs")
}

/// Resolve the OS application-data directory without an extra crate.
fn dirs_app_data() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library").join("Application Support"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local").join("share")))
    }
}
