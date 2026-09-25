export const memoryDiagram = `<svg class="docs-diagram-wide" role="img" viewBox="0 0 720 448" xmlns="http://www.w3.org/2000/svg">
  <title>Memory, step by step</title>
  <desc>How a memory moves. A scan reads your entries and your words in Daily Chat: an on-device model keeps that writing on this computer, any other Memory model receives the text. A short fact is saved in the encrypted database on this device, and no Memlore server keeps a copy. Daily Chat adds a few matching facts only when Use Memory in Chat is on, so the chat provider sees those facts and the matching model sees your message. You can search, rewrite, turn off, or delete facts in Manage memories, and turning Memory off keeps them saved until you turn it back on to manage them.</desc>
  <rect x="16" y="16" width="688" height="416" rx="16" fill="var(--color-panel)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="40" y="52" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Step</text>
  <text x="388" y="52" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Where it goes</text>
  <rect x="40" y="68" width="300" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="60" y="100" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="17">A scan reads your writing</text>
  <text x="60" y="124" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Entries and your chat words</text>
  <path d="M348 106H380" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M372 99L380 106L372 113" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="388" y="68" width="292" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="408" y="100" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">On-device model: stays here</text>
  <text x="408" y="124" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Any other model gets the text</text>
  <path d="M190 144V158" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M183 150L190 158L197 150" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="40" y="160" width="300" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="60" y="192" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="17">A short fact is saved</text>
  <text x="60" y="216" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">One sentence about you</text>
  <path d="M348 198H380" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M372 191L380 198L372 205" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="388" y="160" width="292" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="408" y="192" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Encrypted database, this device</text>
  <text x="408" y="216" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">No Memlore server keeps a copy</text>
  <path d="M190 236V250" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M183 242L190 250L197 242" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="40" y="252" width="300" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="60" y="284" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="17">Daily Chat adds a few facts</text>
  <text x="60" y="308" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Only with Use Memory in Chat on</text>
  <path d="M348 290H380" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M372 283L380 290L372 297" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="388" y="252" width="292" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="408" y="284" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">The chat provider sees them</text>
  <text x="408" y="308" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Matching model sees your message</text>
  <path d="M190 328V342" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M183 334L190 342L197 334" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="40" y="344" width="300" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="60" y="376" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="17">You review the list</text>
  <text x="60" y="400" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">In Manage memories</text>
  <path d="M348 382H380" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M372 375L380 382L372 389" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="388" y="344" width="292" height="76" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="408" y="376" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Rewrite, turn off, or delete</text>
  <text x="408" y="400" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Turning Memory off keeps them</text>
</svg>
<svg class="docs-diagram-narrow" role="img" viewBox="0 0 360 608" xmlns="http://www.w3.org/2000/svg">
  <title>Memory, step by step</title>
  <desc>How a memory moves. A scan reads your entries and your words in Daily Chat: an on-device model keeps that writing on this computer, any other Memory model receives the text. A short fact is saved in the encrypted database on this device, and no Memlore server keeps a copy. Daily Chat adds a few matching facts only when Use Memory in Chat is on, so the chat provider sees those facts and the matching model sees your message. You can search, rewrite, turn off, or delete facts in Manage memories, and turning Memory off keeps them saved until you turn it back on to manage them.</desc>
  <rect x="8" y="8" width="344" height="592" rx="16" fill="var(--color-panel)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <rect x="20" y="24" width="320" height="124" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="36" y="54" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">A scan reads your writing</text>
  <text x="36" y="77" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Entries and your chat words</text>
  <path d="M36 101H52M46 95L52 101L46 107" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="62" y="106" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">On-device model: stays here</text>
  <text x="62" y="130" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Any other model gets the text</text>
  <path d="M180 150V164" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M173 156L180 164L187 156" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="168" width="320" height="124" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="36" y="198" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">A short fact is saved</text>
  <text x="36" y="221" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">One sentence about you</text>
  <path d="M36 245H52M46 239L52 245L46 251" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="62" y="250" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Encrypted database, this device</text>
  <text x="62" y="274" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">No Memlore server keeps a copy</text>
  <path d="M180 294V308" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M173 300L180 308L187 300" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="312" width="320" height="124" rx="12" fill="var(--color-raised)" stroke="var(--color-accent)" stroke-width="2"/>
  <text x="36" y="342" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Daily Chat adds a few facts</text>
  <text x="36" y="365" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Only with Use Memory in Chat on</text>
  <path d="M36 389H52M46 383L52 389L46 395" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="62" y="394" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">The chat provider sees them</text>
  <text x="62" y="418" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Matching model sees your message</text>
  <path d="M180 438V452" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <path d="M173 444L180 452L187 444" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="20" y="456" width="320" height="124" rx="12" fill="var(--color-raised)" stroke="var(--color-rule-strong)" stroke-width="2"/>
  <text x="36" y="486" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">You review the list</text>
  <text x="36" y="509" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">In Manage memories</text>
  <path d="M36 533H52M46 527L52 533L46 539" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="62" y="538" text-anchor="start" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="15">Rewrite, turn off, or delete</text>
  <text x="62" y="562" text-anchor="start" fill="var(--color-muted)" font-family="var(--font-body), sans-serif" font-size="15">Turning Memory off keeps them</text>
</svg>`
