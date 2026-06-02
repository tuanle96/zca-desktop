//! `types` layer — pure data shapes shared across the core (ADR-0003).
//!
//! Lowest layer: no dependency on any other core layer and no `zca-rust`
//! dependency. Higher layers (`zalo`, `command`) map these DTOs as needed.

pub mod account;
pub mod credentials;

pub use account::{AccountId, AccountProfile, CredentialSummary};
pub use credentials::{Cookie, CredentialError, Credentials};
