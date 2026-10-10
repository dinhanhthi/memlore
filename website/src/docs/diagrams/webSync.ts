export const webSyncDiagram = `<svg class="docs-diagram-wide docs-diagram-full" role="img" viewBox="15 15 690 486" xmlns="http://www.w3.org/2000/svg">
  <title>How a web edit reaches your desktop</title>
  <desc>You edit an entry on the web. The browser saves a sealed draft and uploads it to the web outbox, a folder in your Google Drive app data that holds one file per entry. When the desktop app syncs, it reads the outbox, merges the edit into your journal, and writes a receipt for each edit. On its next sync it uploads the merged entry. When the web refreshes, it shows the desktop copy and drops its draft. The outbox file stays on Drive and is overwritten by the next edit of that entry. Text from both sides is kept. For the title, mood, journal, date, favorite, and tags, the desktop wins if it changed them too.</desc>
  <rect x="16" y="16" width="688" height="484" rx="16" fill="var(--color-panel)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <rect x="28" y="30" width="204" height="374" rx="12" fill="var(--color-lane-browser)" stroke="var(--color-lane-browser-edge)" stroke-width="1.5"/>
  <rect x="260" y="30" width="200" height="374" rx="12" fill="var(--color-lane-drive)" stroke="var(--color-lane-drive-edge)" stroke-width="1.5"/>
  <rect x="488" y="30" width="204" height="374" rx="12" fill="var(--color-lane-desktop)" stroke="var(--color-lane-desktop-edge)" stroke-width="1.5"/>
  <text x="40" y="56" text-anchor="start" fill="var(--color-kind-ordinary)" font-family="var(--font-body), sans-serif" font-size="15">This browser</text>
  <text x="272" y="56" text-anchor="start" fill="var(--color-kind-vault)" font-family="var(--font-body), sans-serif" font-size="15">Your Google Drive</text>
  <text x="500" y="56" text-anchor="start" fill="var(--color-kind-second-lock)" font-family="var(--font-body), sans-serif" font-size="15">Desktop app</text>
  <rect x="40" y="72" width="180" height="70" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="56" y="100" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">1 · You edit</text>
  <text x="56" y="124" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Sealed draft saved</text>
  <rect x="272" y="72" width="176" height="150" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="288" y="100" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Web outbox</text>
  <text x="288" y="124" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">One file per entry</text>
  <text x="288" y="146" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Kept, overwritten</text>
  <text x="288" y="168" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">by the next edit</text>
  <rect x="500" y="152" width="180" height="70" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="516" y="180" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">2 · Desktop syncs</text>
  <text x="516" y="204" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Merges the edit</text>
  <rect x="500" y="242" width="180" height="70" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="516" y="270" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">3 · Next sync</text>
  <text x="516" y="294" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Uploads the result</text>
  <rect x="272" y="242" width="176" height="150" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="288" y="270" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Desktop files</text>
  <text x="288" y="294" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Merged entry</text>
  <text x="288" y="316" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Receipt for each</text>
  <text x="288" y="338" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">edit (step 2)</text>
  <rect x="40" y="322" width="180" height="70" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="56" y="350" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">4 · Web refreshes</text>
  <text x="56" y="374" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Shows desktop copy</text>
  <path d="M224 107H268" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M260 100L268 107L260 114" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M452 187H496" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M488 180L496 187L488 194" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M590 226V238" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M583 230L590 238L597 230" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M496 277H452" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M460 270L452 277L460 284" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M268 357H224" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M232 350L224 357L232 364" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="40" y="440" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Text from both sides is kept.</text>
  <text x="40" y="466" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Title, mood, journal, date, favorite, tags: the desktop wins if it changed them too.</text>
</svg>
<svg class="docs-diagram-narrow" role="img" viewBox="0 0 360 760" xmlns="http://www.w3.org/2000/svg">
  <title>How a web edit reaches your desktop</title>
  <desc>You edit an entry on the web. The browser saves a sealed draft and uploads it to the web outbox, a folder in your Google Drive app data that holds one file per entry. When the desktop app syncs, it reads the outbox, merges the edit into your journal, and writes a receipt for each edit. On its next sync it uploads the merged entry. When the web refreshes, it shows the desktop copy and drops its draft. The outbox file stays on Drive and is overwritten by the next edit of that entry. Text from both sides is kept. For the title, mood, journal, date, favorite, and tags, the desktop wins if it changed them too.</desc>
  <rect x="8" y="8" width="344" height="744" rx="16" fill="var(--color-panel)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <rect x="20" y="24" width="320" height="76" rx="12" fill="var(--color-lane-browser)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="36" y="52" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">1 · You edit</text>
  <text x="36" y="76" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">In this browser: sealed draft</text>
  <path d="M180 104V124" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M173 116L180 124L187 116" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="128" width="320" height="76" rx="12" fill="var(--color-lane-drive)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="36" y="156" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Web outbox</text>
  <text x="36" y="180" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">On Drive: one file per entry</text>
  <path d="M180 208V228" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M173 220L180 228L187 220" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="232" width="320" height="76" rx="12" fill="var(--color-lane-desktop)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="36" y="260" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">2 · Desktop syncs</text>
  <text x="36" y="284" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Merges, writes a receipt</text>
  <path d="M180 312V332" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M173 324L180 332L187 324" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="336" width="320" height="76" rx="12" fill="var(--color-lane-desktop)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="36" y="364" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">3 · Next desktop sync</text>
  <text x="36" y="388" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Uploads the result</text>
  <path d="M180 416V436" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M173 428L180 436L187 428" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="440" width="320" height="76" rx="12" fill="var(--color-lane-drive)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="36" y="468" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Desktop files</text>
  <text x="36" y="492" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">On Drive: entry and receipt</text>
  <path d="M180 520V540" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M173 532L180 540L187 532" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="544" width="320" height="76" rx="12" fill="var(--color-lane-browser)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="36" y="572" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">4 · Web refreshes</text>
  <text x="36" y="596" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Shows the desktop copy</text>
  <text x="20" y="656" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Text from both sides is kept.</text>
  <text x="20" y="684" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Title, mood, journal, date,</text>
  <text x="20" y="708" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">favorite, tags: the desktop</text>
  <text x="20" y="732" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">wins if it changed them too.</text>
</svg>`
