//! Wire DTOs for the cloud HTTP contract.
//!
//! The wire shapes now live in the shared `zca-types` crate — the single source
//! of truth, also used to generate the TypeScript bindings (`cargo test -p
//! zca-types --features ts`). This module re-exports them (with `FromRow` enabled
//! via `zca-types`'s `sqlx` feature) and keeps only the few server-internal types
//! that never cross the wire.

use serde::Serialize;
use uuid::Uuid;

pub use zca_types::*;

/// Internal broadcast payload for the realtime SSE fan-out. Not a wire type —
/// `data` is the already-serialized event JSON.
#[derive(Debug, Clone)]
pub struct RealtimeEvent {
    pub user_id: Uuid,
    pub data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub ok: bool,
    pub service: &'static str,
}
