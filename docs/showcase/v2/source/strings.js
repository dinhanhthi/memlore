/* All on-screen copy for the Memlore film, one table per language (?lang=xx).
   Every claim is sourced; the comment beside each group names the file it comes from.
   Real UI labels stay exactly as the app spells them. */
window.STR_PRESET = {
  en: {
    title: "Memlore, in two minutes",
    toggle: "EN",
    chapters: [
      "Cold open",
      "Memlore",
      "Private. Offline. Yours.",
      "01 Write",
      "02 Find",
      "03 Gallery",
      "03 Locations",
      "Mood",
      "04 Daily Chat",
      "Providers",
      "MCP server",
      "05 Protect",
      "06 Sync",
      "Design systems",
      "Download",
    ],
    wordmark: "Memlore",
    tagline: "A little life. A lasting story.", // README.md:4

    /* narrative, no product claim */
    cold: ["Some days are big.", "Most are ordinary.", "Both are worth keeping."],

    /* README.md:19 */
    promise: [
      { word: "Private.", sub: "No Memlore server, no account, no telemetry.", img: "st-privacy" },
      { word: "Offline.", sub: "Works fully offline.", img: "st-offline" },
      { word: "Yours.", sub: "Your journal stays on your device.", img: "st-hi" },
    ],

    caps: {
      /* README.md:20 */
      write: {
        eyebrow: "01 — WRITE",
        head: ["A rich editor."],
        sub: "Write with markdown shortcuts, then add plugins for anything.",
        chips: ["Math", "Code", "Tables", "Checklists", "Media"],
      },
      /* README.md:21; toggle label src/locales/en/ai.json:789; panel src/locales/en/nav.json:307 */
      find: {
        eyebrow: "02 — FIND",
        head: ["Find anything."],
        sub: "Instant search, tags, favorites, calendar, and On This Day lookback.",
        chips: ["Search by meaning", "On This Day"],
      },
      /* README.md:22; src/locales/en/nav.json:11,263 */
      gallery: {
        eyebrow: "03 — REMEMBER",
        head: ["Photos, places,", "and moments."],
        sub: "Photos, video, voice memos, a media gallery, and a locations map.",
      },
      /* labels src/locales/en/editor.json:224-226, card src/locales/en/stats.json:50 */
      mood: {
        eyebrow: "HOW YOU FELT",
        head: ["Your mood,", "over time."],
        sub: "Each entry can carry how you felt: Not good, So-so, or Good.",
      },
      /* README.md:23; src/locales/en/ai.json:167 */
      chat: {
        eyebrow: "04 — ASK",
        head: ["AI, when", "you want it."],
        sub: "A rich set of optional AI tools over your journal. Off until you opt in.",
      },
      /* README.md:25 */
      sync: {
        eyebrow: "06 — SYNC",
        head: ["Sync you", "control."],
        sub: "Encrypted sync over your own Google Drive or iCloud Drive. See who is connected, and revoke any of them.",
      },
    },

    /* src/types/ai.ts:865-1303 (17 providers), README.md:23 */
    orbit: {
      heading: "Bring your own provider, or run models on-device.",
      /* short names on the inner ring (first 7), long ones on the outer ring */
      items: [
        "Ollama",
        "LM Studio",
        "llama-server",
        "Claude CLI",
        "Codex CLI",
        "OpenAI",
        "Anthropic",
        "Integrated chat models",
        "Gemini",
        "Other local server",
        "xAI",
        "OpenRouter",
        "Integrated embedding models",
        "Together",
        "Groq",
        "Voyage AI",
        "Custom",
      ],
      trust: "17 providers · off until you opt in",
    },

    /* README.md:24, CHANGELOG.md:13-20 */
    mcp: {
      eyebrow: "MCP SERVER · v0.2.0",
      head: ["Journal from the AI app", "you already use."],
      sub: "Desktop MCP clients can search, read, create and append entries on your machine.",
      panel: "memlore — MCP tools",
      tools: ["list_journals", "search_entries", "get_entry", "create_entry", "append_to_entry", "set_entry_metadata"],
      foot: "Local only · Off by default · No AI provider required",
    },

    /* README.md:26, labels src/locales/en/settings.json:932-933; crypto README.md tech table */
    locks: {
      eyebrow: "05 — PROTECT",
      head: ["Lock it", "three ways."],
      cards: [
        ["App lock", "A password or Touch ID."],
        ["Second lock", "Hides chosen entries behind an extra password."],
        ["Invisible lock", "Separate vaults that vanish until you enter the right password."],
      ],
      crypto: "AES-256-GCM · Argon2id · SQLCipher",
    },

    /* src/lib/designSystem.ts:10-14, README.md:28 */
    designs: {
      eyebrow: "MAKE IT YOURS",
      head: ["Three design systems.", "Light and dark."],
      shots: [
        ["clay-light", "Clay · Light"],
        ["clay-dark", "Clay · Dark"],
        ["clean-light", "Clean · Light"],
        ["sig-light", "Signature · Light"],
        ["sig-write", "Signature · Dark"],
      ],
    },

    /* README.md:7, CHANGELOG.md:11 (v0.2.0), CHANGELOG.md:59 (macOS 13), package.json:4 + LICENSE:1 (AGPL-3.0-or-later) */
    end: {
      cta: "Download for Mac",
      url: "memlore.app",
      meta: "macOS 13+ · v0.2.0 · Open source · AGPL-3.0",
    },
  },
};
