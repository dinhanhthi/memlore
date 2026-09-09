//! AI foundation — embedder trait, indexer, emotion suggester, error type.
//!
//! Phase 6 v2 (2026-05-07) — see SPECIFICATION.md → "Phase 6 — AI &
//! Intelligence (External Provider model)" for the architecture pivot away
//! from on-device inference. This module now hosts only the shape that
//! survives both backends:
//!
//! - [`error::AiError`] — stable error codes for AI ops.
//! - [`embedder`] — `Embedder` trait, `StubEmbedder`, `SwappableEmbedder`.
//! - [`indexer`] — entry-indexer save-path hook + backfill driver.
//! - [`emotion`] — emotion suggestion ranker (uses `Embedder`).
//!
//! The remote `AIProvider` lives in [`crate::ai::provider`] (added by R2).
//! On-device-specific files (`registry`, `store`, `summary`) were deleted in
//! the pivot.

pub mod audit;
pub mod chunking;
pub mod embedder;
pub mod embedding_decision;
pub mod emotion;
pub mod error;
pub mod feature_prompts;
pub mod indexer;
pub mod memory_extractor;
pub mod on_device;
pub mod persona_builder;
pub mod provider;
pub mod provider_registry;
pub mod providers;
pub mod reflection_lenses;
