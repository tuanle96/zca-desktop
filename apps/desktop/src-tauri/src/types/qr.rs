//! QR-login display DTOs surfaced to the UI (`types` layer, ADR-0003 / ADR-0004).
//!
//! Pure data: no `zca-rust` dependency. The `zalo` layer maps `zca-rust`'s
//! `LoginQREvent` into these DTOs so the frontend only ever sees non-secret
//! display data (the QR image to render, the scanned account's public
//! name/avatar, and coarse stage transitions). The resulting credential triple
//! (imei + cookie + user_agent) is assembled and kept in the core and never
//! crosses this boundary.

use serde::{Deserialize, Serialize};

/// A non-secret QR-login progress event, streamed to the UI as the flow runs.
///
/// Internally tagged on `stage` so the frontend can switch on a single field:
/// `{ "stage": "generated", "image": "<base64 png>" }`,
/// `{ "stage": "scanned", "displayName": "...", "avatar": "..." }`, etc.
///
/// Note: the QR `code`/`token` used for long-polling are intentionally omitted
/// — the UI only needs the rendered image. No imei/cookie/userAgent values are
/// ever carried here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "stage")]
pub enum QrLoginEvent {
    /// A QR code was generated; `image` is a base64-encoded PNG (no data-URI
    /// prefix) for the UI to render. `expires_in_secs` is the validity window
    /// (the core aborts an unscanned QR after it, emitting `Expired`), so the UI
    /// can show a countdown in sync with the core.
    Generated {
        image: String,
        #[serde(rename = "expiresInSecs")]
        expires_in_secs: u64,
    },
    /// The QR was scanned on a phone; carries the scanning account's public
    /// display name + avatar so the UI can preview "who is logging in".
    Scanned {
        #[serde(rename = "displayName")]
        display_name: String,
        avatar: String,
    },
    /// The user declined the login on their phone.
    Declined,
    /// The QR code expired before it was confirmed.
    Expired,
    /// Login completed and a session was established.
    Success,
}
