// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Rust core layers (ADR-0003): types → config → store → zalo → session → command.
pub mod command;
pub mod types;
pub mod zalo;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(command::ListenerState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            command::import_credentials,
            command::login,
            command::start_listening,
            command::send_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
