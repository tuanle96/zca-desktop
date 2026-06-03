//! Sticker DTOs surfaced to the UI (`types` layer, ADR-0003).
//!
//! Pure data: no `zca-rust` dependency. The `zalo` layer maps `zca-rust`'s
//! sticker models (and incoming `chat.sticker` messages) into these DTOs so the
//! frontend never sees `zca-rust` types and renders a sticker by its `url`.

use serde::{Deserialize, Serialize};

/// A sticker reference — the three ids Zalo needs to (re)send a sticker plus a
/// renderable image `url`. Used both for the picker grid (search results) and
/// to describe an incoming/outgoing sticker message.
///
/// `id`/`cat_id`/`sticker_type` mirror `zca-rust`'s `SendStickerPayload`
/// (`stickerId`/`cateId`/`type`); `url` is the Zalo emoticon CDN render URL the
/// UI shows directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Sticker {
    pub id: i64,
    pub cat_id: i64,
    pub sticker_type: i64,
    /// Renderable image URL (Zalo emoticon CDN, allowlisted in the CSP).
    pub url: String,
}
