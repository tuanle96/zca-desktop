//! `types` layer — pure data shapes shared across the core (ADR-0003).
//!
//! Lowest layer: no dependency on any other core layer and no `zca-rust`
//! dependency. Higher layers (`zalo`, `command`) map these DTOs as needed.

pub mod account;
pub mod contact;
pub mod credentials;
pub mod events;
pub mod qr;
pub mod reaction;
pub mod sticker;
pub mod stored;

pub use account::{AccountId, AccountProfile, CredentialSummary};
pub use contact::{Contact, Group};
pub use credentials::{Cookie, CredentialError, Credentials};
pub use events::{IncomingMessage, ThreadKind};
pub use qr::QrLoginEvent;
pub use reaction::{ReactionEvent, ReactionIcon, reaction_icon_from_zalo};
pub use sticker::Sticker;
pub use stored::{History, StoredMessage, StoredThread, ThreadIdentity};
