// Capture the app screenshots the free-style film uses, from the website demo.
//
//   pnpm website:dev --port 5176                 (serves the demo, in another terminal; DEMO_URL overrides http://localhost:5176)
//   node docs/showcase/free-style-vi/capture.mjs    -> ../assets/shots/free-style-vi/*.jpg (1440×900 CSS px @2x)
//   node docs/showcase/free-style-vi/capture.mjs chat,lock   -> only those shots
//
// Every shot starts from a fresh demo load, so one failing step never leaks into the next.
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import url from 'url';
import config from './config.mjs';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.resolve(dir, config.shots);
fs.mkdirSync(outDir, { recursive: true });

// Vietnamese accessible names, from src/locales/vi/*.json (this fork is Vietnamese-only).
const VI = {
  settings: 'Cài đặt', appearance: 'Giao diện', layoutTitle: 'Bố cục',
  light: 'Chủ đề sáng', dark: 'Chủ đề tối',
  surf: { deep: 'Bề mặt charcoal đậm', soft: 'Bề mặt charcoal dịu hơn', lumen: /^Bề mặt tối Lumen/ },
  accent: { rose: 'Hồng', emerald: 'Xanh lá', violet: 'Tím', orange: 'Cam' },
  layout: { contentLeft: /^Nội dung bên trái/, sidebarContent: /^Thanh bên bên trái, nội dung ở giữa/ },
};
// look: { ds, mode, surface, accent, layout } applied through Settings -> Appearance. Only the shots the themes scene uses.
const WRITE = [{ nav: 'write', wait: 2200 }];
const PLAN = {
  'clay-dark': { look: { ds: 'clay', mode: VI.dark }, steps: WRITE },
  'clay-light': { look: { ds: 'clay', mode: VI.light }, steps: WRITE },
  'clean-light': { look: { ds: 'clean', mode: VI.light }, steps: WRITE },
  'clean-dark': { look: { ds: 'clean', mode: VI.dark }, steps: WRITE },
  'sig-light': { look: { ds: 'signature', mode: VI.light }, steps: WRITE },
  'sig-deep': { look: { ds: 'signature', mode: VI.dark, surface: 'deep' }, steps: WRITE },
  'sig-soft': { look: { ds: 'signature', mode: VI.dark, surface: 'soft' }, steps: WRITE },
  'sig-lumen': { look: { ds: 'signature', mode: VI.dark, surface: 'lumen' }, steps: WRITE },
  'accent-rose': { look: { ds: 'clay', mode: VI.dark, accent: VI.accent.rose }, steps: WRITE },
  'accent-emerald': { look: { ds: 'clay', mode: VI.dark, accent: VI.accent.emerald }, steps: WRITE },
  'accent-violet': { look: { ds: 'clay', mode: VI.dark, accent: VI.accent.violet }, steps: WRITE },
  'accent-orange': { look: { ds: 'clay', mode: VI.dark, accent: VI.accent.orange }, steps: WRITE },
  'layout-content-left': { look: { ds: 'clay', mode: VI.dark, layout: VI.layout.contentLeft }, steps: WRITE },
  'layout-sidebar-content': { look: { ds: 'clay', mode: VI.dark, layout: VI.layout.sidebarContent }, steps: WRITE },
};

const only = process.argv[2]?.split(',');
const base = process.env.DEMO_URL ?? 'http://localhost:5176';
const browser = await chromium.launch();
for (const [name, shot] of Object.entries(PLAN)) {
  if (only && !only.includes(name)) continue;
  // the demo reads its language from localStorage at startup; origin-wide, so it covers the demo iframe too
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  await context.addInitScript(() => { localStorage.setItem('memlore-ui', JSON.stringify({ state: { uiLanguage: 'vi' }, version: 0 })); });
  // the demo seed forces uiLanguage 'en' (website/demo/scenario.ts), which useLanguage then applies over the persisted
  // value; serve the seed with 'vi' instead so the read-only demo source stays untouched
  await context.route('**/demo/scenario.ts*', async route => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(/uiLanguage:\s*["']en["']/, "uiLanguage: 'vi'") });
  });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('[pageerror]', name, e.message));
  await page.goto(`${base}/privacy.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.id = 'f'; f.src = '/demo.html';
    f.style.cssText = 'position:fixed;inset:0;width:1440px;height:900px;border:0';
    document.body.replaceChildren(f);
    document.body.style.margin = '0';
  });
  await page.waitForTimeout(3500);
  const frame = page.frameLocator('#f');
  const send = cmd => page.evaluate(c => document.getElementById('f').contentWindow.postMessage({ type: 'memlore-demo-command', version: 1, ...c }, location.origin), cmd);
  const button = n => { const o = { name: n, exact: typeof n === 'string' }; return frame.getByRole('button', o).or(frame.getByRole('link', o)).or(frame.getByRole('radio', o)); };
  const act = async s => {
    try {
      if (s.nav) await send({ command: 'navigate', view: s.nav });
      if (s.click) await (s.last ? button(s.click).last() : button(s.click).first()).click({ timeout: 3000 });
      if (s.text) await frame.getByText(s.text, { exact: !!s.exact }).first().click({ timeout: 3000 });
      if (s.type) await page.keyboard.type(s.type, { delay: 25 });
    } catch (e) { console.log('fail', name, JSON.stringify(s), e.message.split('\n')[0]); }
    await page.waitForTimeout(s.wait ?? 1200);
  };
  if (shot.look) {
    const { ds, mode, surface, accent, layout } = shot.look;
    await send({ command: 'theme', designSystem: ds }); await page.waitForTimeout(600);
    await act({ click: VI.settings, last: true, wait: 800 });
    await act({ text: VI.appearance, exact: true, wait: 900 });
    if (mode) await act({ click: mode, wait: 700 });
    if (surface) await act({ click: VI.surf[surface], wait: 700 });
    if (accent) await act({ click: accent, wait: 700 });
    if (layout) { await act({ text: VI.layoutTitle, exact: true, wait: 700 }); await act({ click: layout, wait: 900 }); }
  }
  for (const s of shot.steps) await act(s);
  await page.mouse.move(1100, 880);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${name}.jpg`), type: 'jpeg', quality: 90 });
  console.log('ok', name);
  await context.close();
}
await browser.close();
