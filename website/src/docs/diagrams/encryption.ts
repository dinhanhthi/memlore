export const encryptionDiagram = `<svg class="docs-diagram-wide" role="img" viewBox="0 0 720 320" xmlns="http://www.w3.org/2000/svg">
  <title>Encryption</title>
  <rect x="24" y="92" width="128" height="120" rx="16" fill="var(--color-panel)" stroke="currentColor" stroke-width="2"/>
  <circle cx="72" cy="140" r="14" fill="none" stroke="var(--color-accent)" stroke-width="2"/>
  <path d="M86 140h34" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M108 140v10M120 140v14" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <text x="88" y="244" text-anchor="middle" fill="currentColor" font-family="var(--font-body)" font-size="15">Your password</text>
  <path d="M160 152h28" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M180 144l10 8-10 8" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="198" y="92" width="148" height="120" rx="16" fill="var(--color-panel)" stroke="currentColor" stroke-width="2"/>
  <path d="M218 128h52M218 148h72M218 168h92" fill="none" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round"/>
  <text x="272" y="244" text-anchor="middle" fill="currentColor" font-family="var(--font-body)" font-size="15">Slow key making</text>
  <path d="M354 152h28" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M374 144l10 8-10 8" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M446 92v-18a22 22 0 0 1 44 0v18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <rect x="392" y="92" width="152" height="120" rx="16" fill="var(--color-paper)" stroke="currentColor" stroke-width="2"/>
  <circle cx="452" cy="142" r="10" fill="none" stroke="var(--color-accent)" stroke-width="2"/>
  <path d="M462 142h28" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M478 142v8M490 142v12" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <text x="468" y="184" text-anchor="middle" fill="currentColor" font-family="var(--font-body)" font-size="14">Master key</text>
  <text x="468" y="244" text-anchor="middle" fill="currentColor" font-family="var(--font-body)" font-size="15">Locked box</text>
  <path d="M552 152h28" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M572 144l10 8-10 8" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="592" y="104" width="104" height="96" rx="12" fill="var(--color-panel)" stroke="currentColor" stroke-width="2"/>
  <path d="M608 132h72M608 152h72M608 172h48" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <text x="644" y="244" text-anchor="middle" fill="currentColor" font-family="var(--font-body)" font-size="15">Journal database</text>
</svg>
<svg class="docs-diagram-narrow" role="img" viewBox="0 0 360 824" xmlns="http://www.w3.org/2000/svg">
  <title>Encryption</title>
  <rect x="80" y="8" width="200" height="112" rx="16" fill="var(--color-panel)" stroke="currentColor" stroke-width="2"/>
  <circle cx="164" cy="52" r="14" fill="none" stroke="var(--color-accent)" stroke-width="2"/>
  <path d="M178 52h34" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M200 52v10M212 52v14" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <text x="180" y="152" text-anchor="middle" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="18">Your password</text>
  <path d="M180 168v28" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M174 188l6 8 6-8" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="70" y="208" width="220" height="112" rx="16" fill="var(--color-panel)" stroke="currentColor" stroke-width="2"/>
  <path d="M98 250h52M98 274h100M98 298h140" fill="none" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round"/>
  <text x="180" y="352" text-anchor="middle" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="18">Slow key making</text>
  <path d="M180 368v28" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M174 388l6 8 6-8" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M158 448v-18a22 22 0 0 1 44 0v18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <rect x="68" y="448" width="224" height="128" rx="16" fill="var(--color-paper)" stroke="currentColor" stroke-width="2"/>
  <circle cx="156" cy="496" r="10" fill="none" stroke="var(--color-accent)" stroke-width="2"/>
  <path d="M166 496h28" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <path d="M182 496v8M194 496v12" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round"/>
  <text x="180" y="548" text-anchor="middle" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="16">Master key</text>
  <text x="180" y="608" text-anchor="middle" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="18">Locked box</text>
  <path d="M180 624v28" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M174 644l6 8 6-8" fill="none" stroke="var(--color-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="90" y="664" width="180" height="96" rx="12" fill="var(--color-panel)" stroke="currentColor" stroke-width="2"/>
  <path d="M110 696h140M110 720h140M110 744h96" fill="none" stroke="var(--color-rule-strong)" stroke-width="2" stroke-linecap="round"/>
  <text x="180" y="792" text-anchor="middle" fill="var(--color-ink)" font-family="var(--font-body), sans-serif" font-size="18">Journal database</text>
</svg>`
