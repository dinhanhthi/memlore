//! Concrete `AIProvider` implementations.
//!
//! Phase 6 v2 R2 lands one impl, [`openai_compat::OpenAICompatibleProvider`],
//! which speaks the OpenAI chat-completions / embeddings / images wire
//! format. That single impl covers every preset on the Phase 6 v2 provider
//! matrix:
//!
//! - **🔒 Local** — Ollama, LM Studio, llama.cpp `llama-server`, vLLM,
//!   LocalAI, anything else exposing an OpenAI-compatible loopback endpoint.
//! - **🌍 Hosted** — OpenAI, Anthropic (via OAI-compat shim at `/v1`),
//!   Gemini (via `generativelanguage.googleapis.com/v1beta/openai`), xAI,
//!   OpenRouter, Together, Groq.
//! - **Custom** — user-supplied endpoint + key.
//!
//! Native non-OAI shapes (Anthropic `/v1/messages`, Gemini `generateContent`)
//! land as separate impls in later chunks if quality measurably differs.

pub mod cli;
pub mod on_device_embed;
pub mod on_device_llm;
pub mod openai_compat;

#[cfg(test)]
pub mod testing;
