//! Dev-only demo data seed primitives (Yjs TipTap builder, catalog, media synth, Wikipedia).
//!
//! **Hard gate:** this entire module is only compiled under
//! `#[cfg(any(debug_assertions, test))]` (see `lib.rs`). Release production
//! binaries do not contain Wikipedia fetch, catalog, or runner code.
//! The Tauri command `seed_demo_data` is additionally gated with
//! `#[cfg(debug_assertions)]` only (no production invoke path).

pub mod catalog;
pub mod media_synth;
pub mod runner;
pub mod wiki;
pub mod yjs_builder;
