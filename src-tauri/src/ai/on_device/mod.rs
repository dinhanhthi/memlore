//! On-device embedding runtime (Embedding Cost Guardrails, 2026-07).
//!
//! The **only** approved on-device ML path in Memlore: opt-in, download-once
//! text embedding via the [`fastembed`] crate (`ort` ONNX Runtime +
//! `tokenizers`). AI *generation* stays external HTTP — nothing here runs
//! generation. Models are **not** bundled; they download at runtime when the
//! user opts into on-device embedding and picks a model.
//!
//! Submodules (added across Phase 4):
//! - `catalog` — recommended model catalog + UI decision metadata (Task 2).
//! - `download` — opt-in, cached, resumable model download manager (Task 2).
//! - `llm_catalog` — on-device **LLM** chat model catalog (Gemma 4 GGUF pins,
//!   Phase 1 Task 2). Separate from `catalog` because LLMs are raw GGUF files
//!   served to a `llama-server` sidecar, not `fastembed` embeddings.
//! - `server_binary` — per-platform `llama-server` binary catalog (Phase 1
//!   Task 3). Pins the llama.cpp release tag + SHA-256-verified prebuilt
//!   archive URLs for each supported (os, arch) so the JIT downloader can
//!   fetch the right sidecar binary.
//! - `llm_download` — JIT download manager for the LLM assets (GGUF weights +
//!   the `llama-server` binary), mirroring `download`'s state-machine but
//!   extracting a single archive member (Phase 2 Task 2).
//! - `server` — `llama-server` subprocess lifecycle manager
//!   ([`server::LlamaServerManager`]): spawns/manages the localhost HTTP
//!   sidecar with a state machine, health-check polling, and concurrency-safe
//!   start/stop (Phase 3 Task 1).
//!
//! The `on-device` provider implementing the embedding trait lives in
//! [`crate::ai::providers::on_device_embed`] (Task 3).

pub mod catalog;
pub mod download;
pub mod fetch;
pub mod llm_catalog;
pub mod llm_download;
pub mod server;
pub mod server_binary;
