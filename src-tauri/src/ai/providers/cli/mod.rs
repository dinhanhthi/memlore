//! Local-CLI AI providers (Claude Code, Codex).
//!
//! These providers spawn a locally-installed CLI binary as a subprocess and
//! parse its JSONL stream. Auth piggybacks on the CLI's own login (Claude
//! subscription / ChatGPT Plus); Memlore never sees an API key.
//!
//! See `NOTES.md` for the exact JSON event shapes each CLI emits and the
//! quirks that drove the parser design (Codex 0.122 lacks token-level
//! deltas, Claude `--bare` strips OAuth, etc.).

pub mod claude;
pub mod codex;
pub mod prompt;
pub mod runtime;
