// Re-capture the app screenshots the film uses, from the website demo.
//
//   pnpm website:dev                                   (serves the demo on :5176)
//   node docs/showcase/source/capture.mjs              -> ../assets/shots/source/*.jpg     (English UI)
//   node docs/showcase/source/capture.mjs vi           -> ../assets/shots/source/vi/*.jpg  (Vietnamese UI)
//
// The demo is hosted in a same-origin parent page so its bridge accepts
// theme / navigate commands. Sample journal content stays English either way.
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const lang = process.argv[2] || 'en';
const outDir = path.join(dir, '..', 'assets', 'shots', 'source', lang === 'en' ? '' : lang);
fs.mkdirSync(outDir, { recursive: true });

// Button labels differ per UI language.
const L = {
  en: { search: 'Search', lookback: 'Lookback', gallery: 'Gallery', theme: 'Toggle theme', lock: 'Lock app' },
  vi: { search: 'Tìm kiếm', lookback: 'Nhìn lại', gallery: 'Thư viện', theme: 'Đổi giao diện', lock: 'Khoá ứng dụng' },
}[lang];
const AWAY = [1100, 500]; // park the pointer so no tooltip shows
const PLAN = [
  { name: 'sig-write', ds: 'signature', steps: [{ nav: 'write', wait: 2500 }, { mouse: AWAY }] },
  { name: 'sig-search', steps: [{ click: L.search, wait: 800 }, { type: 'morning', wait: 2000 }] },
  { name: 'sig-lookback', steps: [{ key: 'Escape', wait: 800 }, { click: L.lookback, wait: 1800 }] },
  { name: 'sig-gallery', steps: [{ click: L.gallery, wait: 2500 }, { mouse: [1435, 5] }] },
  { name: 'sig-chat', steps: [{ nav: 'chat', wait: 1500 }, { text: 'Morning reflections', wait: 2500 }] },
  { name: 'clean-light', ds: 'clean', steps: [{ nav: 'write', wait: 1500 }, { click: L.theme }, { mouse: AWAY }] },
  { name: 'clay-light', ds: 'clay', steps: [{ wait: 2000 }] },
  { name: 'clay-dark-write', steps: [{ click: L.theme }, { mouse: AWAY }] },
  { name: 'sig-lock', ds: 'signature', steps: [{ click: L.lock, wait: 2500 }] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5176/privacy.html', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const f = document.createElement('iframe');
  f.id = 'f'; f.src = '/demo.html';
  f.style.cssText = 'position:fixed;inset:0;width:1440px;height:900px;border:0';
  document.body.replaceChildren(f);
  document.body.style.margin = '0';
});
await page.waitForTimeout(4000);
const frame = page.frameLocator('#f');
const send = cmd => page.evaluate(c => document.getElementById('f').contentWindow.postMessage({ type: 'memlore-demo-command', version: 1, ...c }, location.origin), cmd);
const button = name => frame.getByRole('button', { name, exact: true }).or(frame.getByRole('link', { name, exact: true }));

// The demo keeps its UI language in memory, so switch it through Settings → General.
if (lang === 'vi') {
  await button('Settings').last().click(); await page.waitForTimeout(1200);
  await frame.getByText('General', { exact: true }).first().click(); await page.waitForTimeout(800);
  await frame.getByRole('radio', { name: 'Vietnamese' }).or(frame.getByRole('button', { name: 'Vietnamese' })).first().click();
  await page.waitForTimeout(1200);
}

for (const shot of PLAN) {
  if (shot.ds) { await send({ command: 'theme', designSystem: shot.ds }); await page.waitForTimeout(600); }
  for (const s of shot.steps) {
    try {
      if (s.nav) await send({ command: 'navigate', view: s.nav });
      if (s.click) await button(s.click).first().click({ timeout: 3000 });
      if (s.text) await frame.getByText(s.text, { exact: false }).first().click({ timeout: 3000 });
      if (s.mouse) await page.mouse.move(...s.mouse);
      if (s.key) await page.keyboard.press(s.key);
      if (s.type) await page.keyboard.type(s.type, { delay: 20 });
    } catch (e) { console.log('fail', shot.name, JSON.stringify(s), e.message.split('\n')[0]); }
    await page.waitForTimeout(s.wait ?? 1500);
  }
  await page.screenshot({ path: path.join(outDir, `${shot.name}.jpg`), type: 'jpeg', quality: 90 });
  console.log('ok', path.relative(dir, path.join(outDir, `${shot.name}.jpg`)));
}
await browser.close();
