//! `ProviderRegistry` — Tauri-managed state holding the active
//! generation + embedding providers.
//!
//! **Two-slot design (R11+)**: providers like Claude / Groq / xAI expose
//! chat but not embeddings, so the registry tracks the two surfaces
//! independently. A user can pair Claude (generation) with Voyage or a
//! local Ollama (embedding) and the two slots invalidate / swap / clear
//! without affecting each other.
//!
//! - `generation` slot — used by `chat`, `chat_stream`, `chat_model_id`.
//!   Chat only: image generation moved to its own slot on 2026-08-07 so a
//!   user can chat with one vendor and draw with another.
//! - `image` slot — used by `generate_image`. Independent provider + key;
//!   `generate_inline_image` checks ITS privacy receipt, not the chat
//!   slot's.
//! - `embedding` slot — used by `embed`, `embedding_model_id`, and any
//!   code that composes the `entries_embeddings.model_id` cache key.
//! - `memory_generation` slot — the dedicated generation provider for AI
//!   User Memory + Persona extraction (Phase 2 T2.1), on-machine BY DEFAULT.
//!   Independent of `gen`/`embed`: those slots may be hosted, while the
//!   memory slots are restricted by default to `EndpointClass::Local` /
//!   `EndpointClass::OnDevice` so raw entry/chat content used for
//!   extraction does not leave the machine unless the user opts in. That
//!   default is lifted only when `ai_memory_allow_hosted` is explicitly
//!   turned on (post-ship amendment — see `docs/plans/2026-07-29-ai-user-memory/README.md`'s
//!   Amendment section), in which case `Remote`/`Subscription` become valid
//!   too. The class + capability (generation-capable) rule — including the
//!   `ai_memory_allow_hosted` check — is enforced at swap/build time AND at
//!   registry-hydration time in `commands/ai_settings::enforce_memory_slot_class`
//!   (Phase 2 T2.3); this registry holds whatever was swapped in and does
//!   NOT re-check the flag itself on every access — see
//!   `commands::ai_settings::reject_disallowed_memory_slots` for the
//!   explicit "drop it now" path used when the user revokes the flag.
//! - `memory_embedding` slot — the dedicated embedding provider for AI User
//!   Memory + Persona (Phase 2 T2.2), on-machine BY DEFAULT for the same
//!   reason. Used for memory item embeds, related-memory query embeds, and
//!   chat retrieval query embeds. Memory embedding goes through this slot,
//!   NEVER the app's `embed` slot, which may be hosted (`Remote`) regardless
//!   of the user's memory-specific choice — that fallback would let
//!   entry-derived text egress even with `ai_memory_allow_hosted` off. The
//!   on-machine-by-default rule (class ∈ {`Local`, `OnDevice`} unless
//!   `ai_memory_allow_hosted` + embedding-capable) is enforced the same way
//!   as the generation slot above.
//!
//!
//! Design:
//!
//! - One `Mutex<Option<Arc<dyn AIProvider>>>` per slot. Snapshot clones
//!   the `Arc` and releases the lock, so embed and chat callers never
//!   contend.
//! - **Lock ordering invariant**: today no method takes more than one
//!   slot lock at once, so deadlock is unreachable (this still holds with
//!   the fourth `memory_embedding` slot — its methods only touch the
//!   `memory_embedding` lock). If a future "reset slots atomically" path
//!   is added, it MUST acquire `generation` first, then `embedding`, then
//!   `memory_generation`, then `memory_embedding`. Document the order at
//!   the acquisition site.
//! - Mutex poison is recovered (consistent with `EncryptionKeyState` in
//!   `lib.rs`) — a panic during a swap shouldn't brick AI for the rest
//!   of the session.
//! - **Audit wrapping (S2-1)**: `swap_generation` / `swap_embedding` /
//!   `swap_memory_generation` / `swap_memory_embedding` wrap incoming
//!   providers in `AuditingProvider` before storing. Callers never see
//!   the wrapper — they interact with the inner `AIProvider` API
//!   unchanged.

use crate::ai::audit::{AuditSink, AuditingProvider, NoopAuditSink};
use crate::ai::provider::AIProvider;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub struct ProviderRegistry {
    /// Chat generation slot. Chat ONLY since 2026-08-07 — image generation
    /// moved to its own `image` slot so the two can point at different
    /// vendors.
    generation: Mutex<Option<Arc<dyn AIProvider>>>,
    /// Image generation slot. Independent of `generation`: the provider that
    /// writes best prose is rarely the one that draws best.
    image: Mutex<Option<Arc<dyn AIProvider>>>,
    /// Embeddings slot.
    embedding: Mutex<Option<Arc<dyn AIProvider>>>,
    /// Memory generation slot (Phase 2 T2.1) — generation provider for
    /// memory extraction, on-machine by default (hosted/CLI allowed only
    /// with `ai_memory_allow_hosted` on). Class + generation-capability is
    /// enforced at swap time in `commands/ai_settings.rs`; the registry
    /// holds whatever was swapped in.
    memory_generation: Mutex<Option<Arc<dyn AIProvider>>>,
    /// Memory embedding slot (Phase 2 T2.2) — embedding provider for memory
    /// item / query embeds, on-machine by default (hosted/CLI allowed only
    /// with `ai_memory_allow_hosted` on). Class + embedding-capability is
    /// enforced at swap time in `commands/ai_settings.rs`; the registry
    /// holds whatever was swapped in.
    memory_embedding: Mutex<Option<Arc<dyn AIProvider>>>,
    /// Tracks whether we've already logged a "mutex poisoned" warning.
    /// `snapshot()` runs on every embed/chat/image call — without this
    /// flag a single poison event would flood the log with thousands of
    /// duplicate warnings and bury any real signal.
    poison_logged: AtomicBool,
    /// Audit sink shared across both slots. Every provider swapped in gets
    /// wrapped in `AuditingProvider(inner, Arc::clone(&sink))`.
    sink: Arc<dyn AuditSink>,
}

impl ProviderRegistry {
    /// Construct a registry with an explicit audit sink.
    /// Production code passes a `SqliteAuditSink`; tests that don't care
    /// about audit rows use `Default::default()` which installs a `NoopAuditSink`.
    pub fn new(sink: Arc<dyn AuditSink>) -> Self {
        Self {
            generation: Mutex::new(None),
            image: Mutex::new(None),
            embedding: Mutex::new(None),
            memory_generation: Mutex::new(None),
            memory_embedding: Mutex::new(None),
            poison_logged: AtomicBool::new(false),
            sink,
        }
    }

    fn lock<'a>(
        &'a self,
        slot: &'a Mutex<Option<Arc<dyn AIProvider>>>,
    ) -> std::sync::MutexGuard<'a, Option<Arc<dyn AIProvider>>> {
        match slot.lock() {
            Ok(g) => g,
            Err(p) => {
                // `compare_exchange` so only the FIRST poisoned-lock observer
                // logs the warning. Subsequent observers just recover the
                // guard silently. `Relaxed` is fine — we only need at-most-
                // once semantics, not strict ordering.
                if self
                    .poison_logged
                    .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
                {
                    log::warn!(
                        "ProviderRegistry mutex was poisoned; recovering. Investigate the panic that caused this. (further occurrences suppressed)"
                    );
                }
                p.into_inner()
            }
        }
    }

    // ── Two-slot API (R11+) ─────────────────────────────────────────────────

    /// Cheap snapshot of the generation (chat + image) provider.
    pub fn generation(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.generation).clone()
    }

    /// Cheap snapshot of the image-generation provider.
    pub fn image(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.image).clone()
    }

    /// Cheap snapshot of the embedding provider.
    pub fn embedding(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.embedding).clone()
    }

    /// Replace the generation provider. The incoming provider is wrapped in
    /// `AuditingProvider` before being stored — callers interact with the
    /// same `AIProvider` interface unchanged. Returns the prior (wrapped)
    /// provider so the caller can drop it on a background thread if needed.
    pub fn swap_generation(&self, next: Arc<dyn AIProvider>) -> Option<Arc<dyn AIProvider>> {
        let wrapped: Arc<dyn AIProvider> =
            Arc::new(AuditingProvider::new(next, Arc::clone(&self.sink)));
        let mut guard = self.lock(&self.generation);
        std::mem::replace(&mut *guard, Some(wrapped))
    }

    /// Replace the image-generation provider (same wrapping contract as
    /// `swap_generation` — image calls are audited too).
    pub fn swap_image(&self, next: Arc<dyn AIProvider>) -> Option<Arc<dyn AIProvider>> {
        let wrapped: Arc<dyn AIProvider> =
            Arc::new(AuditingProvider::new(next, Arc::clone(&self.sink)));
        let mut guard = self.lock(&self.image);
        std::mem::replace(&mut *guard, Some(wrapped))
    }

    /// Replace the embedding provider (same wrapping contract as
    /// `swap_generation`).
    pub fn swap_embedding(&self, next: Arc<dyn AIProvider>) -> Option<Arc<dyn AIProvider>> {
        let wrapped: Arc<dyn AIProvider> =
            Arc::new(AuditingProvider::new(next, Arc::clone(&self.sink)));
        let mut guard = self.lock(&self.embedding);
        std::mem::replace(&mut *guard, Some(wrapped))
    }

    /// Drop the generation provider. Subsequent `generation()` returns
    /// `None` and chat/image commands should return
    /// `AiError::ProviderNotConfigured`.
    pub fn clear_generation(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.generation).take()
    }

    /// Drop the image-generation provider. Subsequent `image()` returns
    /// `None` and `generate_inline_image` returns
    /// `AiError::ProviderNotConfigured`.
    pub fn clear_image(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.image).take()
    }

    /// Drop the embedding provider.
    pub fn clear_embedding(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.embedding).take()
    }

    pub fn is_generation_configured(&self) -> bool {
        self.lock(&self.generation).is_some()
    }

    pub fn is_embedding_configured(&self) -> bool {
        self.lock(&self.embedding).is_some()
    }

    // ── Memory generation slot (Phase 2 T2.1) ───────────────────────────────

    /// Cheap snapshot of the memory generation provider (on-machine by
    /// default for memory extraction; hosted/CLI once `ai_memory_allow_hosted`
    /// is on).
    ///
    /// The class + capability rule (class ∈ {`Local`, `OnDevice`} unless
    /// `ai_memory_allow_hosted`, AND generation-capable) is enforced at
    /// swap/build time in `commands/ai_settings::enforce_memory_slot_class`
    /// (Phase 2 T2.3), BEFORE the provider reaches `swap_memory_generation`,
    /// and again at registry-hydration time (`commands/ai_provider::load_memory_gen_slot`).
    /// This accessor trusts those gates and just returns the slot —
    /// mirroring how `generation()`/`embedding()` defer their own class
    /// rules to `commands/ai_provider.rs`. Returns `None` when the slot is
    /// empty (no valid memory generation model configured → the memory
    /// feature stays off) or after `reject_disallowed_memory_slots` has
    /// cleared a slot the user just revoked hosted-consent for.
    pub fn memory_generation(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.memory_generation).clone()
    }

    /// Replace the memory generation provider (same wrapping contract as
    /// `swap_generation`). Callers MUST have already enforced the class +
    /// generation-capability rule — this registry does not re-check it.
    pub fn swap_memory_generation(&self, next: Arc<dyn AIProvider>) -> Option<Arc<dyn AIProvider>> {
        let wrapped: Arc<dyn AIProvider> =
            Arc::new(AuditingProvider::new(next, Arc::clone(&self.sink)));
        let mut guard = self.lock(&self.memory_generation);
        std::mem::replace(&mut *guard, Some(wrapped))
    }

    /// Drop the memory generation provider. Subsequent `memory_generation()`
    /// returns `None`.
    pub fn clear_memory_generation(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.memory_generation).take()
    }

    pub fn is_memory_generation_configured(&self) -> bool {
        self.lock(&self.memory_generation).is_some()
    }

    // ── Memory embedding slot (Phase 2 T2.2) ────────────────────────────────

    /// Cheap snapshot of the memory embedding provider (on-machine by
    /// default for memory item / query embeds; hosted/CLI once
    /// `ai_memory_allow_hosted` is on).
    ///
    /// Memory embedding goes through this slot, NEVER the app's `embed`
    /// slot, which may be hosted (`Remote`) regardless of the user's
    /// memory-specific choice and would let entry-derived text egress even
    /// with `ai_memory_allow_hosted` off. The class + capability rule
    /// (class ∈ {`Local`, `OnDevice`} unless `ai_memory_allow_hosted`, +
    /// embedding-capable — rejects generation-only `on-device-llm`
    /// regardless of the flag) is enforced at swap time in
    /// `commands/ai_settings::enforce_memory_slot_class` (Phase 2 T2.3) and
    /// again at registry-hydration time (`commands/ai_provider::load_memory_embed_slot`);
    /// this accessor trusts those gates and just returns the slot —
    /// mirroring how `generation()`/`embedding()` defer their own class
    /// rules to `commands/ai_provider.rs`. Returns `None` when the slot is
    /// empty (no valid memory embedding model configured → the memory
    /// feature stays off) or after a hosted-consent revocation cleared it.
    pub fn memory_embedder(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.memory_embedding).clone()
    }

    /// Replace the memory embedding provider (same wrapping contract as
    /// `swap_embedding`). Callers MUST have already enforced the class +
    /// embedding-capability rule — this registry does not re-check it.
    pub fn swap_memory_embedding(&self, next: Arc<dyn AIProvider>) -> Option<Arc<dyn AIProvider>> {
        let wrapped: Arc<dyn AIProvider> =
            Arc::new(AuditingProvider::new(next, Arc::clone(&self.sink)));
        let mut guard = self.lock(&self.memory_embedding);
        std::mem::replace(&mut *guard, Some(wrapped))
    }

    /// Drop the memory embedding provider. Subsequent `memory_embedder()`
    /// returns `None`.
    pub fn clear_memory_embedding(&self) -> Option<Arc<dyn AIProvider>> {
        self.lock(&self.memory_embedding).take()
    }

    pub fn is_memory_embedding_configured(&self) -> bool {
        self.lock(&self.memory_embedding).is_some()
    }

    // ── Memory enable gate (Phase 2 T2.2) ───────────────────────────────────

    /// The single gate every memory feature checks before doing ANY memory
    /// work. `true` ONLY when BOTH the memory generation slot AND the
    /// memory embed slot are configured (hold a built provider). Half a
    /// pair is NOT a working feature — a valid gen slot with no embed slot
    /// cannot retrieve/index. When `false`, the entire feature is OFF: no
    /// extraction, no scan, no retrieval, no injection into Daily Chat
    /// (decision 2). This gate does NOT itself enforce the on-machine
    /// class+capability rule — that is enforced at swap time (T2.3); it
    /// only checks both slots are populated.
    pub fn is_memory_enabled(&self) -> bool {
        self.memory_generation().is_some() && self.memory_embedder().is_some()
    }
}

impl Default for ProviderRegistry {
    /// Builds a registry with a `NoopAuditSink`. Suitable for tests that
    /// don't need to assert on audit rows. Production code should call
    /// `ProviderRegistry::new(sink)` with a `SqliteAuditSink`.
    fn default() -> Self {
        Self::new(Arc::new(NoopAuditSink))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::error::AiError;
    use crate::ai::provider::{ChatOpts, Message};
    use async_trait::async_trait;

    struct FakeProvider {
        id: &'static str,
    }

    #[async_trait]
    impl AIProvider for FakeProvider {
        fn id(&self) -> &str {
            self.id
        }
        fn display_name(&self) -> &str {
            "Fake"
        }
        fn embedding_model_id(&self) -> &str {
            "fake-embed"
        }
        async fn embed(&self, _texts: &[&str]) -> Result<Vec<Vec<f32>>, AiError> {
            Ok(vec![])
        }
        async fn chat(&self, _m: &[Message], _o: ChatOpts) -> Result<String, AiError> {
            Ok(String::new())
        }
    }

    #[test]
    fn registry_starts_empty() {
        let r = ProviderRegistry::default();
        assert!(!r.is_generation_configured());
        assert!(r.generation().is_none());
    }

    #[test]
    fn image_slot_starts_empty() {
        let r = ProviderRegistry::default();
        assert!(r.image().is_none());
    }

    #[test]
    fn swap_image_returns_prior_provider() {
        let r = ProviderRegistry::default();
        let first: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "first" });
        assert!(r.swap_image(Arc::clone(&first)).is_none());
        assert_eq!(r.image().unwrap().id(), "first");

        let second: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "second" });
        assert_eq!(r.swap_image(Arc::clone(&second)).unwrap().id(), "first");
        assert_eq!(r.image().unwrap().id(), "second");
    }

    #[test]
    fn clear_image_drops_active_provider() {
        let r = ProviderRegistry::default();
        r.swap_image(Arc::new(FakeProvider { id: "img" }));
        assert_eq!(r.clear_image().unwrap().id(), "img");
        assert!(r.image().is_none());
        assert!(r.clear_image().is_none());
    }

    /// The whole point of the slot: configuring one must never disturb the
    /// other. Chat and image are independent providers.
    #[test]
    fn image_and_generation_slots_are_independent() {
        let r = ProviderRegistry::default();
        r.swap_generation(Arc::new(FakeProvider {
            id: "chat-provider",
        }));
        r.swap_image(Arc::new(FakeProvider {
            id: "image-provider",
        }));

        assert_eq!(r.generation().unwrap().id(), "chat-provider");
        assert_eq!(r.image().unwrap().id(), "image-provider");

        r.clear_image();
        assert!(r.image().is_none());
        assert_eq!(
            r.generation().unwrap().id(),
            "chat-provider",
            "clearing the image slot must not touch generation"
        );

        r.swap_image(Arc::new(FakeProvider { id: "image-2" }));
        r.clear_generation();
        assert!(r.generation().is_none());
        assert_eq!(
            r.image().unwrap().id(),
            "image-2",
            "clearing generation must not touch the image slot"
        );
    }

    #[test]
    fn swap_returns_prior_provider() {
        let r = ProviderRegistry::default();
        let first: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "first" });
        let prior = r.swap_generation(Arc::clone(&first));
        assert!(prior.is_none());
        assert!(r.is_generation_configured());
        assert_eq!(r.generation().unwrap().id(), "first");

        let second: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "second" });
        let prior = r.swap_generation(Arc::clone(&second));
        assert_eq!(prior.unwrap().id(), "first");
        assert_eq!(r.generation().unwrap().id(), "second");
    }

    #[test]
    fn clear_drops_active_provider() {
        let r = ProviderRegistry::default();
        let p: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "x" });
        r.swap_generation(p);
        assert!(r.is_generation_configured());
        let dropped = r.clear_generation();
        assert_eq!(dropped.unwrap().id(), "x");
        assert!(!r.is_generation_configured());
        assert!(r.generation().is_none());
    }

    // ── Two-slot API (R11+) ─────────────────────────────────────────────────

    #[test]
    fn two_slot_starts_empty() {
        let r = ProviderRegistry::default();
        assert!(!r.is_generation_configured());
        assert!(!r.is_embedding_configured());
        assert!(r.generation().is_none());
        assert!(r.embedding().is_none());
    }

    #[test]
    fn swap_generation_does_not_touch_embedding_slot() {
        let r = ProviderRegistry::default();
        let chat: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "claude" });
        let prior = r.swap_generation(Arc::clone(&chat));
        assert!(prior.is_none());
        assert!(r.is_generation_configured());
        assert!(!r.is_embedding_configured());
        assert_eq!(r.generation().unwrap().id(), "claude");
        assert!(r.embedding().is_none());
    }

    #[test]
    fn swap_embedding_does_not_touch_generation_slot() {
        let r = ProviderRegistry::default();
        let embed: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "voyage" });
        let prior = r.swap_embedding(Arc::clone(&embed));
        assert!(prior.is_none());
        assert!(!r.is_generation_configured());
        assert!(r.is_embedding_configured());
        assert!(r.generation().is_none());
        assert_eq!(r.embedding().unwrap().id(), "voyage");
    }

    #[test]
    fn slots_can_hold_different_providers_simultaneously() {
        let r = ProviderRegistry::default();
        r.swap_generation(Arc::new(FakeProvider { id: "claude" }));
        r.swap_embedding(Arc::new(FakeProvider { id: "voyage" }));
        assert_eq!(r.generation().unwrap().id(), "claude");
        assert_eq!(r.embedding().unwrap().id(), "voyage");
    }

    #[test]
    fn clear_generation_only_drops_generation_slot() {
        let r = ProviderRegistry::default();
        r.swap_generation(Arc::new(FakeProvider { id: "claude" }));
        r.swap_embedding(Arc::new(FakeProvider { id: "voyage" }));
        let dropped = r.clear_generation();
        assert_eq!(dropped.unwrap().id(), "claude");
        assert!(!r.is_generation_configured());
        // Embedding slot untouched.
        assert!(r.is_embedding_configured());
        assert_eq!(r.embedding().unwrap().id(), "voyage");
    }

    #[test]
    fn clear_embedding_only_drops_embedding_slot() {
        let r = ProviderRegistry::default();
        r.swap_generation(Arc::new(FakeProvider { id: "claude" }));
        r.swap_embedding(Arc::new(FakeProvider { id: "voyage" }));
        let dropped = r.clear_embedding();
        assert_eq!(dropped.unwrap().id(), "voyage");
        assert!(!r.is_embedding_configured());
        // Generation slot untouched.
        assert!(r.is_generation_configured());
        assert_eq!(r.generation().unwrap().id(), "claude");
    }

    // ── Memory generation slot (Phase 2 T2.1) ───────────────────────────────

    #[test]
    fn swap_memory_generation_stores_and_returns() {
        let r = ProviderRegistry::default();
        assert!(!r.is_memory_generation_configured());
        assert!(r.memory_generation().is_none());

        let first: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "ollama" });
        let prior = r.swap_memory_generation(Arc::clone(&first));
        assert!(prior.is_none());
        assert!(r.is_memory_generation_configured());
        assert_eq!(r.memory_generation().unwrap().id(), "ollama");

        // Swapping returns the prior (wrapped) provider and stores the new one.
        let second: Arc<dyn AIProvider> = Arc::new(FakeProvider {
            id: "on-device-llm",
        });
        let prior = r.swap_memory_generation(Arc::clone(&second));
        assert_eq!(prior.unwrap().id(), "ollama");
        assert_eq!(r.memory_generation().unwrap().id(), "on-device-llm");
    }

    #[test]
    fn clear_memory_generation_drops_slot() {
        let r = ProviderRegistry::default();
        r.swap_memory_generation(Arc::new(FakeProvider { id: "ollama" }));
        assert!(r.is_memory_generation_configured());

        let dropped = r.clear_memory_generation();
        assert_eq!(dropped.unwrap().id(), "ollama");
        assert!(!r.is_memory_generation_configured());
        assert!(r.memory_generation().is_none());
    }

    #[test]
    fn is_memory_generation_configured_reflects_state() {
        let r = ProviderRegistry::default();
        assert!(!r.is_memory_generation_configured());

        r.swap_memory_generation(Arc::new(FakeProvider { id: "ollama" }));
        assert!(r.is_memory_generation_configured());

        r.clear_memory_generation();
        assert!(!r.is_memory_generation_configured());
    }

    #[test]
    fn swap_memory_generation_does_not_touch_gen_or_embed_slots() {
        // The memory slot is independent — touching it never disturbs the
        // app-wide gen/embed slots (lock ordering invariant: this test
        // exercises that the memory methods only hold the memory lock).
        let r = ProviderRegistry::default();
        r.swap_generation(Arc::new(FakeProvider { id: "claude" }));
        r.swap_embedding(Arc::new(FakeProvider { id: "voyage" }));

        r.swap_memory_generation(Arc::new(FakeProvider { id: "ollama" }));
        assert_eq!(r.generation().unwrap().id(), "claude");
        assert_eq!(r.embedding().unwrap().id(), "voyage");
        assert_eq!(r.memory_generation().unwrap().id(), "ollama");

        r.clear_memory_generation();
        assert!(r.memory_generation().is_none());
        // gen/embed still intact.
        assert!(r.is_generation_configured());
        assert!(r.is_embedding_configured());
    }

    // ── Memory embedding slot (Phase 2 T2.2) ────────────────────────────────

    #[test]
    fn swap_memory_embedding_stores_and_returns() {
        let r = ProviderRegistry::default();
        assert!(!r.is_memory_embedding_configured());
        assert!(r.memory_embedder().is_none());

        let first: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "fastembed" });
        let prior = r.swap_memory_embedding(Arc::clone(&first));
        assert!(prior.is_none());
        assert!(r.is_memory_embedding_configured());
        assert_eq!(r.memory_embedder().unwrap().id(), "fastembed");

        // Swapping returns the prior (wrapped) provider and stores the new one.
        let second: Arc<dyn AIProvider> = Arc::new(FakeProvider { id: "ollama-embed" });
        let prior = r.swap_memory_embedding(Arc::clone(&second));
        assert_eq!(prior.unwrap().id(), "fastembed");
        assert_eq!(r.memory_embedder().unwrap().id(), "ollama-embed");
    }

    #[test]
    fn clear_memory_embedding_drops_slot() {
        let r = ProviderRegistry::default();
        r.swap_memory_embedding(Arc::new(FakeProvider { id: "fastembed" }));
        assert!(r.is_memory_embedding_configured());

        let dropped = r.clear_memory_embedding();
        assert_eq!(dropped.unwrap().id(), "fastembed");
        assert!(!r.is_memory_embedding_configured());
        assert!(r.memory_embedder().is_none());
    }

    #[test]
    fn is_memory_enabled_is_false_when_either_slot_empty() {
        // The gate is an AND over both memory slots — half a pair is NOT a
        // working feature.
        let r = ProviderRegistry::default();
        assert!(!r.is_memory_enabled());

        // Gen set, embed empty → false.
        r.swap_memory_generation(Arc::new(FakeProvider { id: "ollama" }));
        assert!(!r.is_memory_enabled());

        // Both set → true.
        r.swap_memory_embedding(Arc::new(FakeProvider { id: "fastembed" }));
        assert!(r.is_memory_enabled());

        // Clear gen → false again.
        r.clear_memory_generation();
        assert!(!r.is_memory_enabled());
    }

    #[test]
    fn is_memory_enabled_true_only_when_both_slots_set() {
        let r = ProviderRegistry::default();

        // Embed-only → false.
        r.swap_memory_embedding(Arc::new(FakeProvider { id: "fastembed" }));
        assert!(!r.is_memory_enabled());

        // Add gen → true.
        r.swap_memory_generation(Arc::new(FakeProvider { id: "ollama" }));
        assert!(r.is_memory_enabled());

        // Drop embed → false.
        r.clear_memory_embedding();
        assert!(!r.is_memory_enabled());
    }

    // ── S2-1: audit wrapping tests ──────────────────────────────────────────

    #[test]
    fn provider_registry_swaps_apply_auditing_wrapper() {
        use crate::ai::audit::SqliteAuditSink;
        use crate::db::queries::{list_ai_audit_log, AiAuditLogFilter};
        use crate::db::schema::migrate;
        use rusqlite::Connection;
        use std::sync::Mutex;
        use tokio::runtime::Runtime;

        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let sink: Arc<dyn crate::ai::audit::AuditSink> =
            Arc::new(SqliteAuditSink::new(Arc::clone(&db)));
        let r = ProviderRegistry::new(sink);
        r.swap_generation(Arc::new(FakeProvider { id: "audited" }));

        let provider = r.generation().unwrap();
        // The stored provider should be an AuditingProvider wrapper.
        // Call embed and verify a row appears in the audit log.
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let _ = provider.embed(&["test"]).await;
        });
        let guard = db.lock().unwrap();
        let rows = list_ai_audit_log(&guard, &AiAuditLogFilter::default(), 10, 0).unwrap();
        assert_eq!(rows.len(), 1, "expected one audit row after embed call");
        assert_eq!(rows[0].provider_id, "audited");
    }

    #[test]
    fn provider_registry_clear_releases_wrapped_provider() {
        let r = ProviderRegistry::default();
        r.swap_generation(Arc::new(FakeProvider { id: "claude" }));
        assert!(r.is_generation_configured());
        let dropped = r.clear_generation();
        assert!(
            dropped.is_some(),
            "clear_generation should return the wrapped provider"
        );
        assert!(!r.is_generation_configured());
        assert!(r.generation().is_none());
    }
}
