//! `types` layer — pure data shapes shared across the core (ADR-0003).
//!
//! Lowest layer: no dependency on any other core layer and no `zca-rust`
//! dependency. Higher layers (`zalo`, `command`) map these DTOs as needed.

pub mod account;
pub mod cloud_callback;
pub mod contact;
pub mod credentials;
pub mod events;
pub mod link;
pub mod qr;
pub mod quote;
pub mod reaction;
pub mod sticker;
pub mod stored;
pub mod undo;

pub use account::{AccountId, AccountProfile, CredentialSummary};
pub use cloud_callback::{MagicLinkCallbackPayload, OAuthCallbackPayload};
pub use contact::{Contact, Group};
pub use credentials::{Cookie, CredentialError, Credentials};
pub use events::{IncomingMessage, ThreadKind};
pub use link::LinkPreview;
pub use qr::QrLoginEvent;
pub use quote::{QuoteInput, QuoteRef};
pub use reaction::{reaction_icon_from_zalo, ReactionEvent, ReactionIcon};
pub use sticker::Sticker;
pub use stored::{History, StoredMessage, StoredThread, ThreadIdentity};
pub use undo::UndoEvent;
