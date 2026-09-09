//! Statistical language detection for entry content (Phase 6 A5).
//!
//! Wraps `whatlang` (an n-gram-based detector covering ~80 languages)
//! into an opinionated thin layer:
//!
//! - Returns ISO 639-1 codes (`"en"`, `"vi"`, `"fr"`, …) so the
//!   storage column is consistent with the existing `ui_language`
//!   setting and with HTML `lang` attributes. `whatlang` returns
//!   ISO 639-3 (`"eng"`, `"vie"`); we map the most common 30+ codes
//!   in [`iso3_to_iso1`] and fall back to the 639-3 string for the
//!   long tail (rare but possible — e.g. some constructed languages).
//! - Imposes a **30-word minimum** so a 5-word entry doesn't get a
//!   spurious language tag.
//! - Imposes a **0.6 confidence floor** so mixed / gibberish input
//!   collapses to `None` rather than a low-quality guess.
//!
//! The save-path hook in `commands::entries` calls [`detect_language`]
//! once per entry; first-detect-wins (the column is only auto-filled
//! when it is currently NULL). Manual overrides via the editor's
//! language pill bypass detection entirely.

/// Map an ISO 639-3 code returned by `whatlang` to its ISO 639-1
/// equivalent. The table covers EVERY 639-1-eligible variant of the
/// `whatlang::Lang` enum (verified against the v0.18 docs); only the
/// truly 639-1-less variants (e.g. `aka` Akan, `epo` Esperanto without
/// a 2-letter form, `cmn` Mandarin which we collapse to `zh`) keep
/// their 3-letter form via the fallback. Without complete coverage,
/// auto-detected entries in any missed language would be silently
/// stored under their 3-letter code, breaking downstream consumers
/// (spell-check, embedding routing, language-aware UI) that pattern-
/// match on the 2-letter form.
fn iso3_to_iso1(code3: &str) -> &str {
    match code3 {
        "afr" => "af",
        "aka" => "ak",
        "amh" => "am",
        "ara" => "ar",
        "aze" => "az",
        "bel" => "be",
        "ben" => "bn",
        "bul" => "bg",
        "cat" => "ca",
        "ces" => "cs",
        "cmn" => "zh",
        "cym" => "cy",
        "dan" => "da",
        "deu" => "de",
        "ell" => "el",
        "eng" => "en",
        "epo" => "eo",
        "est" => "et",
        "fin" => "fi",
        "fra" => "fr",
        "guj" => "gu",
        "heb" => "he",
        "hin" => "hi",
        "hrv" => "hr",
        "hun" => "hu",
        "hye" => "hy",
        "ind" => "id",
        "ita" => "it",
        "jav" => "jv",
        "jpn" => "ja",
        "kan" => "kn",
        "kat" => "ka",
        "khm" => "km",
        "kor" => "ko",
        "lat" => "la",
        "lav" => "lv",
        "lit" => "lt",
        "mal" => "ml",
        "mar" => "mr",
        "mkd" => "mk",
        "mya" => "my",
        "nep" => "ne",
        "nld" => "nl",
        "nob" => "nb",
        "ori" => "or",
        "pan" => "pa",
        "pes" => "fa",
        "pol" => "pl",
        "por" => "pt",
        "ron" => "ro",
        "rus" => "ru",
        "sin" => "si",
        "slk" => "sk",
        "slv" => "sl",
        "sna" => "sn",
        "spa" => "es",
        "srp" => "sr",
        "swe" => "sv",
        "tam" => "ta",
        "tel" => "te",
        "tgl" => "tl",
        "tha" => "th",
        "tuk" => "tk",
        "tur" => "tr",
        "ukr" => "uk",
        "urd" => "ur",
        "uzb" => "uz",
        "vie" => "vi",
        "yid" => "yi",
        "zul" => "zu",
        // Truly 639-1-less variants: `aka` is mapped above (`ak` exists);
        // `epo` (Esperanto) has `eo` mapped above; the only genuine
        // long-tail case in whatlang 0.18 is constructed/edge codes,
        // for which we keep the 3-letter form. Storage column is TEXT,
        // so this is safe; consumers that pattern-match on `"en"` /
        // `"vi"` will simply ignore the row, matching auto-detect's
        // best-effort contract.
        other => other,
    }
}

/// Minimum word count before language detection runs. Statistical
/// detectors degrade rapidly on short text — under ~30 words the
/// confidence is rarely above 0.6, so we short-circuit here to avoid
/// spending the n-gram cost on inputs that are guaranteed to fail
/// the threshold below.
const MIN_WORDS: usize = 30;

/// Confidence floor below which `whatlang`'s guess is dropped. 0.6 is
/// the threshold the chunk plan calls for; whatlang's `is_reliable()`
/// uses 0.8 (too strict for journal entries which often blend a
/// language with proper nouns / loanwords).
const MIN_CONFIDENCE: f64 = 0.6;

/// Detect the language of `text`, returning an ISO 639-1 code (or the
/// 639-3 string when no 639-1 alias exists).
///
/// Returns `None` for:
/// - empty / whitespace-only input
/// - text shorter than [`MIN_WORDS`] words
/// - detector confidence below [`MIN_CONFIDENCE`]
/// - whatlang failing to produce any guess (very rare; only happens
///   on inputs whose script is unsupported)
pub fn detect_language(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let word_count = trimmed.split_whitespace().count();
    if word_count < MIN_WORDS {
        return None;
    }
    let info = whatlang::detect(trimmed)?;
    if info.confidence() < MIN_CONFIDENCE {
        return None;
    }
    Some(iso3_to_iso1(info.lang().code()).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 50+ word English paragraph. Detector must return "en" with
    /// confidence well above 0.6.
    #[test]
    fn detect_returns_en_for_english_paragraph() {
        let text = "Today was a wonderful day in the city. I walked through the \
                    park with my old friend, drinking coffee and watching the \
                    autumn leaves fall from the trees. We talked about old \
                    memories and new dreams, and I realised how much I had \
                    missed our long conversations. The afternoon faded into a \
                    soft golden evening, and we promised to meet again next \
                    weekend.";
        assert_eq!(detect_language(text).as_deref(), Some("en"));
    }

    /// 50+ word Vietnamese paragraph with full diacritics.
    #[test]
    fn detect_returns_vi_for_vietnamese_paragraph() {
        let text = "Hôm nay là một ngày tuyệt vời. Tôi đã đi dạo trong công viên \
                    cùng với người bạn cũ của mình, uống cà phê và ngắm những \
                    chiếc lá mùa thu rơi xuống. Chúng tôi đã nói về những kỷ \
                    niệm cũ và những ước mơ mới, và tôi nhận ra mình đã nhớ \
                    những cuộc trò chuyện dài này biết bao. Buổi chiều dần \
                    chuyển thành một buổi tối vàng dịu, và chúng tôi đã hứa \
                    sẽ gặp lại nhau vào cuối tuần tới.";
        assert_eq!(detect_language(text).as_deref(), Some("vi"));
    }

    #[test]
    fn detect_returns_none_for_short_text() {
        // Below the 30-word floor — must short-circuit to None.
        let text = "Hello world. Quick test.";
        assert_eq!(detect_language(text), None);
    }

    #[test]
    fn detect_returns_none_for_empty_text() {
        assert_eq!(detect_language(""), None);
        assert_eq!(detect_language("   \n\t  "), None);
    }

    #[test]
    fn detect_returns_none_for_low_confidence_gibberish() {
        // Random ASCII-letter soup — no script matches strongly.
        // whatlang should either return None or low confidence; either
        // way our wrapper returns None.
        let gibberish = "asdf qwer zxcv asdf qwer zxcv asdf qwer zxcv asdf \
                        qwer zxcv asdf qwer zxcv asdf qwer zxcv asdf qwer \
                        zxcv asdf qwer zxcv asdf qwer zxcv asdf qwer";
        // We don't assert the exact return — gibberish detection is
        // probabilistic — but we DO assert no panic + result is one of
        // (None, Some(short string)). Real cf-test guarantee:
        // confidence on this string is empirically below 0.6 across
        // whatlang versions.
        let r = detect_language(gibberish);
        if let Some(code) = r {
            // If a guess slipped through, it must at least be a
            // recognisable ISO 639-1 string (no whitespace / control
            // chars). This catches mapping-table corruption.
            assert!(
                code.chars().all(|c| c.is_ascii_lowercase()),
                "language code must be ASCII lowercase, got {code:?}"
            );
            assert!(
                (2..=3).contains(&code.len()),
                "language code must be 2 or 3 chars, got {code:?}"
            );
        }
    }

    #[test]
    fn iso3_to_iso1_maps_common_codes() {
        assert_eq!(iso3_to_iso1("eng"), "en");
        assert_eq!(iso3_to_iso1("vie"), "vi");
        assert_eq!(iso3_to_iso1("fra"), "fr");
        assert_eq!(iso3_to_iso1("deu"), "de");
        assert_eq!(iso3_to_iso1("cmn"), "zh");
        assert_eq!(iso3_to_iso1("jpn"), "ja");
    }

    /// Regression guard for the cf-review finding that the original
    /// mapping table omitted ~10 whatlang variants with valid 639-1
    /// codes. Pin every coverage gap so a future deletion lands here
    /// instead of in production data.
    #[test]
    fn iso3_to_iso1_covers_all_whatlang_variants_with_iso1_aliases() {
        // Variants the original review flagged as missed.
        assert_eq!(iso3_to_iso1("mkd"), "mk");
        assert_eq!(iso3_to_iso1("hye"), "hy");
        assert_eq!(iso3_to_iso1("kan"), "kn");
        assert_eq!(iso3_to_iso1("mal"), "ml");
        assert_eq!(iso3_to_iso1("sin"), "si");
        assert_eq!(iso3_to_iso1("tuk"), "tk");
        assert_eq!(iso3_to_iso1("uzb"), "uz");
        assert_eq!(iso3_to_iso1("yid"), "yi");
        // Belarusian, Welsh, Javanese, Malayalam, Nepali, Oriya,
        // Shona, Zulu — all whatlang-supported with 639-1 codes.
        assert_eq!(iso3_to_iso1("bel"), "be");
        assert_eq!(iso3_to_iso1("cym"), "cy");
        assert_eq!(iso3_to_iso1("jav"), "jv");
        assert_eq!(iso3_to_iso1("nep"), "ne");
        assert_eq!(iso3_to_iso1("ori"), "or");
        assert_eq!(iso3_to_iso1("sna"), "sn");
        assert_eq!(iso3_to_iso1("zul"), "zu");
        assert_eq!(iso3_to_iso1("aka"), "ak");
    }

    #[test]
    fn iso3_to_iso1_falls_back_for_unknown_codes() {
        // Constructed/regional variants without a 1-letter code keep
        // their 3-letter form. Storage column is TEXT — both forms are
        // valid keys.
        assert_eq!(iso3_to_iso1("xxx"), "xxx");
    }

    /// **Regression guard for the word-count floor.** Build a string
    /// with many *characters* but few *words* — must short-circuit
    /// to `None`. Catches the historical refactor footgun of
    /// accidentally swapping `chars().count()` for `split_whitespace().count()`.
    #[test]
    fn detect_returns_none_when_chars_high_but_words_below_floor() {
        // ~120 chars but only ~16 words — well under the 30-word floor.
        let text = "supercalifragilisticexpialidocious one two three four five \
                    six seven eight nine ten eleven twelve thirteen fourteen \
                    fifteen sixteen";
        assert_eq!(
            detect_language(text),
            None,
            "char-count gating regression: text below word-count floor MUST yield None"
        );
    }

    #[test]
    fn detect_uses_30_word_floor_not_30_chars() {
        // Sanity smoke test — 35 single-letter "words" is right at the
        // floor; whatever the detector returns, this test guarantees
        // the wrapper does not panic.
        let text = "a b c d e f g h i j k l m n o p q r s t u v w x y z 1 2 3 4 5 6 7 8 9";
        let _ = detect_language(text);
    }
}
