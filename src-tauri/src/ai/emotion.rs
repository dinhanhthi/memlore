//! Emotion suggestion via cosine similarity against pre-embedded
//! prototype prompts (Phase 6 A6, refactored 2026-05-15 to 3 states).
//!
//! Reuses the embedding model that A3 already loaded — no extra model
//! download. The `EmotionSuggester` embeds a fixed set of 3 prototype
//! sentences once, caches the resulting unit vectors, and ranks an
//! incoming entry vector against them via dot product (the
//! `Embedder` trait guarantees L2-normalised output, so cosine
//! similarity collapses to a dot product).
//!
//! **Why 3 instead of 8:** the user-facing model collapsed from
//! 8 emojis × 5 intensity levels to a 3-state choice (bad / neutral /
//! good). Three coarser polar buckets are easier for the embedder to
//! discriminate cleanly than eight fine-grained ones, which lets us
//! drop the threshold a notch (`0.4` → `0.35`) without flooding the
//! UI with weak suggestions.

use std::sync::{Arc, Mutex};

use crate::ai::embedder::SwappableEmbedder;
use crate::ai::error::AiError;

/// 3-prototype mapping from emotion key (matches `src/components/common/emotions.ts`)
/// to a one-line description used for embedding.
///
/// Adding/removing entries here is a breaking change for the frontend's
/// emotion picker (new emotions must also land in `EMOTIONS` in TypeScript
/// with matching keys + emojis + i18n keys). Keep in lockstep.
pub static EMOTION_PROTOTYPES: &[(&str, &str)] = &[
    (
        "bad",
        "This text expresses sadness, anger, anxiety, or exhaustion — the writer is having a hard time.",
    ),
    (
        "neutral",
        "This text is matter-of-fact or describes an ordinary day with no strong positive or negative feeling.",
    ),
    (
        "good",
        "This text expresses happiness, excitement, calm, or contentment — the writer is feeling good.",
    ),
];

/// Vietnamese mirrors of [`EMOTION_PROTOTYPES`]. Multilingual embedding
/// models like `text-embedding-3-small` give cross-language cosine
/// scores in the 0.25–0.35 range even for a perfect semantic match,
/// which sits below [`SUGGESTION_THRESHOLD`] and silently kills the
/// suggestion chip for non-English entries. Picking a same-language
/// prototype set per entry keeps the score in the same band as the
/// English-on-English case the threshold was tuned for.
///
/// The key order MUST match `EMOTION_PROTOTYPES` (the cache build path
/// pairs `keys × vectors` positionally).
pub static EMOTION_PROTOTYPES_VI: &[(&str, &str)] = &[
    (
        "bad",
        "Đoạn văn này thể hiện sự buồn bã, tức giận, lo lắng, hoặc kiệt sức — người viết đang gặp khó khăn.",
    ),
    (
        "neutral",
        "Đoạn văn này mang tính trần thuật, mô tả một ngày bình thường, không có cảm xúc tích cực hay tiêu cực rõ rệt.",
    ),
    (
        "good",
        "Đoạn văn này thể hiện niềm vui, sự phấn khích, bình yên, hoặc hài lòng — người viết đang cảm thấy ổn.",
    ),
];

/// French mirrors of [`EMOTION_PROTOTYPES`]. Same key order constraint as
/// [`EMOTION_PROTOTYPES_VI`].
pub static EMOTION_PROTOTYPES_FR: &[(&str, &str)] = &[
    (
        "bad",
        "Ce texte exprime de la tristesse, de la colère, de l'anxiété ou de l'épuisement — l'auteur traverse un moment difficile.",
    ),
    (
        "neutral",
        "Ce texte est factuel ou décrit une journée ordinaire, sans émotion positive ou négative marquée.",
    ),
    (
        "good",
        "Ce texte exprime du bonheur, de l'enthousiasme, du calme ou du contentement — l'auteur se sent bien.",
    ),
];

/// Spanish mirrors of [`EMOTION_PROTOTYPES`]. Same key order constraint as
/// [`EMOTION_PROTOTYPES_VI`].
pub static EMOTION_PROTOTYPES_ES: &[(&str, &str)] = &[
    (
        "bad",
        "Este texto expresa tristeza, enojo, ansiedad o agotamiento — el autor está pasando por un momento difícil.",
    ),
    (
        "neutral",
        "Este texto es factual o describe un día común, sin emociones positivas o negativas marcadas.",
    ),
    (
        "good",
        "Este texto expresa felicidad, entusiasmo, calma o satisfacción — el autor se siente bien.",
    ),
];

/// Simplified Chinese (zh-Hans) mirrors of [`EMOTION_PROTOTYPES`].
pub static EMOTION_PROTOTYPES_ZH_HANS: &[(&str, &str)] = &[
    (
        "bad",
        "这段文字表达了悲伤、愤怒、焦虑或疲惫——作者过得不顺心。",
    ),
    (
        "neutral",
        "这段文字平淡叙事或描述普通的一天，没有强烈的正面或负面情感。",
    ),
    (
        "good",
        "这段文字表达了快乐、兴奋、平静或满足——作者感觉良好。",
    ),
];

/// Traditional Chinese (zh-Hant) mirrors of [`EMOTION_PROTOTYPES`].
pub static EMOTION_PROTOTYPES_ZH_HANT: &[(&str, &str)] = &[
    (
        "bad",
        "這段文字表達了悲傷、憤怒、焦慮或疲憊——作者過得不順心。",
    ),
    (
        "neutral",
        "這段文字平淡敘事或描述普通的一天，沒有強烈的正面或負面情感。",
    ),
    (
        "good",
        "這段文字表達了快樂、興奮、平靜或滿足——作者感覺良好。",
    ),
];

/// Pick the right prototype set for an entry's `content_language`. Falls
/// back to English for unknown / missing languages — the cosine gap is
/// least bad for the most common case (no detection + entry actually in
/// English).
pub fn prototypes_for_language(lang: Option<&str>) -> &'static [(&'static str, &'static str)] {
    match lang {
        Some("vi") => EMOTION_PROTOTYPES_VI,
        Some("fr") => EMOTION_PROTOTYPES_FR,
        Some("es") => EMOTION_PROTOTYPES_ES,
        Some("zh-Hans") => EMOTION_PROTOTYPES_ZH_HANS,
        Some("zh-Hant") => EMOTION_PROTOTYPES_ZH_HANT,
        _ => EMOTION_PROTOTYPES,
    }
}

/// One ranked emotion suggestion. Returned sorted descending by `score`
/// so the frontend can pick `[0]` as "top suggestion."
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct EmotionScore {
    /// One of the 3 keys in [`EMOTION_PROTOTYPES`]: `"bad" | "neutral" | "good"`.
    /// Matches the `EmotionKey` union in `src/components/common/emotions.ts`.
    pub emotion: String,
    /// Cosine similarity in `[-1.0, 1.0]`, higher = better match.
    pub score: f32,
}

/// Threshold below which `suggest_top` returns `None`. Lowered from `0.4`
/// (8-bucket era) to `0.35` because 3 polar buckets carry more signal per
/// score-point than 8 fine-grained ones — anything above 0.35 is
/// reasonably interpretable. Pinned in tests so a future tweak surfaces
/// instead of silently changing UX.
pub const SUGGESTION_THRESHOLD: f32 = 0.35;

/// Pre-computed prototype embeddings + the `model_id` they were built
/// against. Cosine ranking against `prototype_vectors` is just a dot
/// product on each pair (the Embedder trait L2-normalises every output
/// vector).
///
/// Cheap to build (3 short embed calls) but not free — cache in
/// `Tauri::manage` with model-id invalidation so the runtime swap
/// path (Stub → ONNX → Stub on app lock grace) doesn't leave stale
/// vectors around.
pub struct EmotionSuggester {
    pub model_id: String,
    pub prototype_vectors: Vec<(String, Vec<f32>)>,
}

impl EmotionSuggester {
    /// Build a suggester by embedding each prototype against the
    /// currently-active backend of `embedder`. Snapshots the backend
    /// once so all 3 prototypes are embedded with the same model id
    /// even if a swap lands mid-build.
    pub fn build(embedder: &SwappableEmbedder) -> Result<Self, AiError> {
        let backend = embedder.snapshot();
        let model_id = backend.model_id().to_string();
        let mut prototype_vectors = Vec::with_capacity(EMOTION_PROTOTYPES.len());
        for (key, prompt) in EMOTION_PROTOTYPES {
            let v = backend.embed(prompt)?;
            prototype_vectors.push(((*key).to_string(), v));
        }
        Ok(Self {
            model_id,
            prototype_vectors,
        })
    }

    /// Rank `entry_vec` against every prototype, returning a list of
    /// `EmotionScore` sorted descending by score. Always returns 3
    /// entries (one per prototype).
    pub fn rank(&self, entry_vec: &[f32]) -> Vec<EmotionScore> {
        let mut scores: Vec<EmotionScore> = self
            .prototype_vectors
            .iter()
            .map(|(emotion, proto)| EmotionScore {
                emotion: emotion.clone(),
                score: cosine_unit(entry_vec, proto),
            })
            .collect();
        // Sort descending. `partial_cmp` returns None for NaN; treat NaN
        // as worst so the well-defined comparisons stay stable.
        scores.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scores
    }

    /// Convenience: top-1 ranked emotion, returning `None` when the
    /// best score is under the threshold (the UI's suggestion chip
    /// uses this directly to decide whether to render).
    pub fn suggest_top(&self, entry_vec: &[f32]) -> Option<EmotionScore> {
        let ranked = self.rank(entry_vec);
        let top = ranked.into_iter().next()?;
        if top.score < SUGGESTION_THRESHOLD {
            None
        } else {
            Some(top)
        }
    }
}

/// Cosine similarity over two L2-unit vectors of equal length. The
/// `Embedder` trait L2-normalises every output, so this is the same
/// monotonic ranker `commands::search::semantic_search` uses. Falls
/// back to 0.0 on mismatched dims (defensive — a stale row from a
/// previous model id should never reach this; caller pre-filters by
/// `model_id`).
fn cosine_unit(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut acc = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        acc += x * y;
    }
    acc
}

/// Tauri-managed cache for the prototype embeddings. Holds an
/// `Arc<EmotionSuggester>` keyed on the embedder's `model_id`. On
/// each `suggest_emotion` call we snapshot the active backend's
/// `model_id` and:
///
/// 1. If the cache is present AND its `model_id` matches → reuse.
/// 2. Else build a fresh `EmotionSuggester` (3 embed calls), store it.
pub struct EmotionSuggesterCache {
    inner: Mutex<Option<Arc<EmotionSuggester>>>,
}

impl EmotionSuggesterCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<EmotionSuggester>>> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    /// Return the cached suggester if it matches the embedder's
    /// current `model_id`; otherwise build a new one, cache it, and
    /// return it.
    pub fn get_or_build(
        &self,
        embedder: &SwappableEmbedder,
    ) -> Result<Arc<EmotionSuggester>, AiError> {
        let active_model_id = embedder.current_model_id();
        {
            let guard = self.lock();
            if let Some(cached) = guard.as_ref() {
                if cached.model_id == active_model_id {
                    return Ok(Arc::clone(cached));
                }
            }
        }
        let suggester = Arc::new(EmotionSuggester::build(embedder)?);
        let mut guard = self.lock();
        if let Some(cached) = guard.as_ref() {
            if cached.model_id == suggester.model_id {
                return Ok(Arc::clone(cached));
            }
        }
        *guard = Some(Arc::clone(&suggester));
        Ok(suggester)
    }

    /// Drop the cached suggester. Used when the embedder is
    /// explicitly disposed (app:locked grace expiry, manual unload)
    /// so the prototype vectors release alongside the model session.
    pub fn invalidate(&self) {
        *self.lock() = None;
    }

    /// Get-or-build keyed by an explicit `model_id`. Phase 6 v2 R4
    /// path — used by `suggest_emotion` which talks to an
    /// `Arc<dyn AIProvider>` directly rather than an `Embedder`-trait
    /// snapshot.
    ///
    /// `build` MUST return exactly `prototypes.len()` vectors in the
    /// same order as `prototypes`. The caller is expected to pass the
    /// prototype phrases through one batched `provider.embed(&texts)`
    /// call so a model-id mismatch can't produce a half-built suggester.
    pub async fn get_or_build_async<F, Fut>(
        &self,
        model_id: &str,
        prototypes: &'static [(&'static str, &'static str)],
        build: F,
    ) -> Result<Arc<EmotionSuggester>, AiError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Vec<Vec<f32>>, AiError>>,
    {
        {
            let guard = self.lock();
            if let Some(cached) = guard.as_ref() {
                if cached.model_id == model_id {
                    return Ok(Arc::clone(cached));
                }
            }
        }
        let vectors = build().await?;
        if vectors.len() != prototypes.len() {
            return Err(AiError::ProviderError(format!(
                "EmotionSuggesterCache::get_or_build_async expected {} vectors, got {}",
                prototypes.len(),
                vectors.len()
            )));
        }
        let prototype_vectors: Vec<(String, Vec<f32>)> = prototypes
            .iter()
            .map(|(k, _)| (*k).to_string())
            .zip(vectors)
            .collect();
        let suggester = Arc::new(EmotionSuggester {
            model_id: model_id.to_string(),
            prototype_vectors,
        });
        let mut guard = self.lock();
        if let Some(cached) = guard.as_ref() {
            if cached.model_id == suggester.model_id {
                return Ok(Arc::clone(cached));
            }
        }
        *guard = Some(Arc::clone(&suggester));
        Ok(suggester)
    }
}

impl Default for EmotionSuggesterCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::embedder::{Embedder, StubEmbedder};
    use std::sync::Arc;

    #[test]
    fn prototypes_for_language_picks_the_right_set_and_falls_back_to_en_otherwise() {
        let en = prototypes_for_language(Some("en"));
        let vi = prototypes_for_language(Some("vi"));
        let fr = prototypes_for_language(Some("fr"));
        let es = prototypes_for_language(Some("es"));
        let zh_hans = prototypes_for_language(Some("zh-Hans"));
        let zh_hant = prototypes_for_language(Some("zh-Hant"));
        let none = prototypes_for_language(None);
        let unknown = prototypes_for_language(Some("ja"));

        assert!(std::ptr::eq(en, EMOTION_PROTOTYPES));
        assert!(std::ptr::eq(vi, EMOTION_PROTOTYPES_VI));
        assert!(std::ptr::eq(fr, EMOTION_PROTOTYPES_FR));
        assert!(std::ptr::eq(es, EMOTION_PROTOTYPES_ES));
        assert!(std::ptr::eq(zh_hans, EMOTION_PROTOTYPES_ZH_HANS));
        assert!(std::ptr::eq(zh_hant, EMOTION_PROTOTYPES_ZH_HANT));
        assert!(std::ptr::eq(none, EMOTION_PROTOTYPES));
        assert!(std::ptr::eq(unknown, EMOTION_PROTOTYPES));

        // Length + key alignment across all language sets — the cache
        // build pairs keys × vectors positionally so any drift would
        // mislabel suggestions for that language.
        let translated: &[(&str, &[(&str, &str)])] = &[
            ("vi", EMOTION_PROTOTYPES_VI),
            ("fr", EMOTION_PROTOTYPES_FR),
            ("es", EMOTION_PROTOTYPES_ES),
            ("zh-Hans", EMOTION_PROTOTYPES_ZH_HANS),
            ("zh-Hant", EMOTION_PROTOTYPES_ZH_HANT),
        ];
        for (lang, set) in translated {
            assert_eq!(
                EMOTION_PROTOTYPES.len(),
                set.len(),
                "{lang} prototype set length differs from EN baseline",
            );
            for (i, ((en_key, _), (other_key, _))) in
                EMOTION_PROTOTYPES.iter().zip(set.iter()).enumerate()
            {
                assert_eq!(
                    en_key, other_key,
                    "{lang} prototype key mismatch at index {i}: EN={en_key} vs {lang}={other_key}",
                );
            }
        }
    }

    /// A custom embedder that returns a fixed vector per input string,
    /// falling back to a deterministic basis-0 unit for unmapped strings.
    struct LookupEmbedder {
        model_id: String,
        dim: usize,
        responses: std::collections::HashMap<String, Vec<f32>>,
    }
    impl LookupEmbedder {
        fn new(model_id: &str, dim: usize) -> Self {
            Self {
                model_id: model_id.to_string(),
                dim,
                responses: std::collections::HashMap::new(),
            }
        }
        fn with(mut self, prompt: &str, vec: Vec<f32>) -> Self {
            self.responses.insert(prompt.to_string(), vec);
            self
        }
    }
    impl Embedder for LookupEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, text: &str) -> Result<Vec<f32>, AiError> {
            if let Some(v) = self.responses.get(text) {
                return Ok(v.clone());
            }
            let mut v = vec![0.0f32; self.dim];
            v[0] = 1.0;
            Ok(v)
        }
    }

    #[test]
    fn emotion_suggester_loads_three_prototypes() {
        let s = SwappableEmbedder::new(Arc::new(StubEmbedder::default_for_dev()));
        let suggester = EmotionSuggester::build(&s).expect("build");
        assert_eq!(suggester.prototype_vectors.len(), 3);
        let keys: Vec<&str> = suggester
            .prototype_vectors
            .iter()
            .map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(keys, vec!["bad", "neutral", "good"]);
        assert_eq!(suggester.model_id, "embedding-stub-768");
    }

    #[test]
    fn emotion_suggester_ranks_polar_text_to_correct_bucket() {
        // Build orthogonal anchors for each of the 3 prototypes, then
        // pose a query aligned with each anchor in turn. Each query
        // must rank its own prototype on top with a clean cosine of 1.
        let dim = 8;
        let mut anchors: Vec<Vec<f32>> = Vec::with_capacity(3);
        for i in 0..3 {
            let mut v = vec![0.0f32; dim];
            v[i] = 1.0;
            anchors.push(v);
        }

        let mut emb = LookupEmbedder::new("test-emo", dim);
        for ((key, prompt), anchor) in EMOTION_PROTOTYPES.iter().zip(anchors.iter()) {
            emb = emb.with(prompt, anchor.clone());
            // Sanity: each key is one of the expected 3 — fails loudly
            // if the prototype constant diverges from the test plan.
            assert!(matches!(*key, "bad" | "neutral" | "good"));
        }
        let s = SwappableEmbedder::new(Arc::new(emb));
        let suggester = EmotionSuggester::build(&s).expect("build");

        for ((expected_key, _), anchor) in EMOTION_PROTOTYPES.iter().zip(anchors.iter()) {
            let top = suggester.suggest_top(anchor).expect("suggestion");
            assert_eq!(
                &top.emotion, expected_key,
                "query aligned with prototype {expected_key} must rank it top, got {}",
                top.emotion
            );
            assert!(
                (top.score - 1.0).abs() < 1e-6,
                "score must be ≈ 1.0 for exact-match query, got {}",
                top.score
            );
        }
    }

    #[test]
    fn emotion_suggester_returns_none_when_below_threshold() {
        // All prototype anchors point in basis-0; query orthogonal in
        // basis-1 → cosine 0 → under threshold → suggest_top is None.
        let dim = 8;
        let mut basis_0 = vec![0.0f32; dim];
        basis_0[0] = 1.0;
        let mut basis_1 = vec![0.0f32; dim];
        basis_1[1] = 1.0;

        let mut emb = LookupEmbedder::new("test-emo", dim);
        for (_, prompt) in EMOTION_PROTOTYPES {
            emb = emb.with(prompt, basis_0.clone());
        }
        let s = SwappableEmbedder::new(Arc::new(emb));
        let suggester = EmotionSuggester::build(&s).expect("build");

        assert!(suggester.suggest_top(&basis_1).is_none());
    }

    #[test]
    fn emotion_suggester_rank_returns_three_sorted_descending() {
        let s = SwappableEmbedder::new(Arc::new(StubEmbedder::default_for_dev()));
        let suggester = EmotionSuggester::build(&s).expect("build");
        let query = suggester.prototype_vectors[0].1.clone();
        let ranked = suggester.rank(&query);
        assert_eq!(ranked.len(), 3);
        for w in ranked.windows(2) {
            assert!(
                w[0].score >= w[1].score,
                "rank result must be descending: {} >= {}",
                w[0].score,
                w[1].score
            );
        }
    }

    #[test]
    fn rank_handles_nan_score_without_panic() {
        let suggester = EmotionSuggester {
            model_id: "test".into(),
            prototype_vectors: vec![
                ("bad".into(), vec![1.0, 0.0]),
                ("neutral".into(), vec![f32::NAN, f32::NAN]),
                ("good".into(), vec![0.0, 1.0]),
            ],
        };
        let ranked = suggester.rank(&[1.0, 0.0]);
        assert_eq!(ranked.len(), 3);
    }

    #[test]
    fn cosine_unit_returns_zero_for_mismatched_dims() {
        assert_eq!(cosine_unit(&[1.0, 0.0], &[1.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn suggestion_threshold_is_pinned() {
        // A future tweak surfaces here instead of silently changing UX.
        assert!((SUGGESTION_THRESHOLD - 0.35).abs() < f32::EPSILON);
    }

    // ─── EmotionSuggesterCache ─────────────────────────────────────────────

    #[test]
    fn cache_get_or_build_caches_first_call() {
        let s = SwappableEmbedder::new(Arc::new(StubEmbedder::default_for_dev()));
        let cache = EmotionSuggesterCache::new();
        let a = cache.get_or_build(&s).expect("build a");
        let b = cache.get_or_build(&s).expect("build b");
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn cache_rebuilds_when_model_changes() {
        let s = SwappableEmbedder::new(Arc::new(StubEmbedder::new("model-a", 768)));
        let cache = EmotionSuggesterCache::new();
        let a = cache.get_or_build(&s).expect("build a");
        assert_eq!(a.model_id, "model-a");

        s.swap(Arc::new(StubEmbedder::new("model-b", 768)));
        let b = cache.get_or_build(&s).expect("build b");
        assert_eq!(b.model_id, "model-b");
        assert!(!Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn cache_invalidate_drops_cached_suggester() {
        let s = SwappableEmbedder::new(Arc::new(StubEmbedder::default_for_dev()));
        let cache = EmotionSuggesterCache::new();
        let a = cache.get_or_build(&s).expect("build a");
        cache.invalidate();
        let b = cache.get_or_build(&s).expect("build b");
        assert!(!Arc::ptr_eq(&a, &b));
    }
}
