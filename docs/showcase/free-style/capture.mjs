// Capture the app screenshots the free-style film uses, from the website demo.
//
//   pnpm website:dev --port 5176                 (serves the demo, in another terminal)
//   node docs/showcase/free-style/capture.mjs    -> ../assets/shots/free-style/*.jpg (1440×900 CSS px @2x)
//   node docs/showcase/free-style/capture.mjs chat,lock   -> only those shots
//
// Every shot starts from a fresh demo load, so one failing step never leaks into the next.
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const outDir = path.join(dir, '..', 'assets', 'shots', 'free-style');
fs.mkdirSync(outDir, { recursive: true });

// look: { ds, mode: 'Light theme' | 'Dark theme', surface, accent, size, layout } applied through Settings → Appearance.
const SURF = { deep: 'Deep charcoal surfaces', soft: 'Soft lifted charcoal surfaces', lumen: /^Lumen dark/ };
const WRITE = [{ nav: 'write', wait: 2200 }];
const PLAN = {
  'clay-dark': { look: { ds: 'clay', mode: 'Dark theme' }, steps: WRITE },
  'clay-light': { look: { ds: 'clay', mode: 'Light theme' }, steps: WRITE },
  'clean-light': { look: { ds: 'clean', mode: 'Light theme' }, steps: WRITE },
  'clean-dark': { look: { ds: 'clean', mode: 'Dark theme' }, steps: WRITE },
  'sig-light': { look: { ds: 'signature', mode: 'Light theme' }, steps: WRITE },
  'sig-deep': { look: { ds: 'signature', mode: 'Dark theme', surface: 'deep' }, steps: WRITE },
  'sig-soft': { look: { ds: 'signature', mode: 'Dark theme', surface: 'soft' }, steps: WRITE },
  'sig-lumen': { look: { ds: 'signature', mode: 'Dark theme', surface: 'lumen' }, steps: WRITE },
  'accent-rose': { look: { ds: 'clay', mode: 'Dark theme', accent: 'Rose' }, steps: WRITE },
  'accent-emerald': { look: { ds: 'clay', mode: 'Dark theme', accent: 'Emerald' }, steps: WRITE },
  'accent-violet': { look: { ds: 'clay', mode: 'Dark theme', accent: 'Violet' }, steps: WRITE },
  'accent-orange': { look: { ds: 'clay', mode: 'Dark theme', accent: 'Orange' }, steps: WRITE },
  'layout-content-left': { look: { ds: 'clay', mode: 'Dark theme', layout: /^Content on the left/ }, steps: WRITE },
  'layout-sidebar-content': { look: { ds: 'clay', mode: 'Dark theme', layout: /^Sidebar on the left, content/ }, steps: WRITE },
  'size-bigger': { look: { ds: 'clay', mode: 'Dark theme', size: /^Bigger interface size/ }, steps: WRITE },
  home: { steps: [{ click: 'Home', wait: 2200 }] },
  chat: { steps: [{ click: 'Chat', wait: 900 }, { text: 'Morning reflections', wait: 2200 }] },
  gallery: { steps: [{ click: 'Gallery', wait: 2500 }] },
  lookback: { steps: [{ click: 'Lookback', wait: 2200 }] },
  calendar: { steps: [{ click: 'Calendar', wait: 2000 }] },
  stats: { steps: [{ click: 'Statistics', wait: 2500 }] },
  tags: { steps: [{ click: 'Tags', wait: 1800 }] },
  search: { steps: [{ click: 'Search', wait: 700 }, { type: 'morning', wait: 2200 }] },
  palette: { steps: [{ click: 'Command palette', wait: 1500 }] },
  aiactions: { steps: [{ click: 'AI actions', wait: 1500 }] },
  lock: { steps: [{ click: 'Lock app', wait: 2500 }] },
  secondlock: { steps: [{ click: 'Unlock second lock', wait: 1500 }] },
  appearance: { steps: [{ click: 'Settings', last: true, wait: 900 }, { text: 'Appearance', exact: true, wait: 1500 }] },
  security: { steps: [{ click: 'Settings', last: true, wait: 900 }, { text: 'Security', exact: true, wait: 1500 }] },
  aisettings: { steps: [{ click: 'Settings', last: true, wait: 900 }, { text: 'AI', exact: true, wait: 1800 }] },
  sync: { steps: [{ click: 'Settings', last: true, wait: 900 }, { text: 'Sync', exact: true, wait: 1800 }] },
  data: { steps: [{ click: 'Settings', last: true, wait: 900 }, { text: 'Data', exact: true, wait: 1800 }] },
  editorsettings: { steps: [{ click: 'Settings', last: true, wait: 900 }, { text: 'Editor', exact: true, wait: 1800 }] },
};

const only = process.argv[2]?.split(',');
const browser = await chromium.launch();
for (const [name, shot] of Object.entries(PLAN)) {
  if (only && !only.includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  page.on('pageerror', e => console.log('[pageerror]', name, e.message));
  await page.goto('http://localhost:5176/privacy.html', { waitUntil: 'networkidle' });
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
    const { ds, mode, surface, accent, layout, size } = shot.look;
    await send({ command: 'theme', designSystem: ds }); await page.waitForTimeout(600);
    await act({ click: 'Settings', last: true, wait: 800 });
    await act({ text: 'Appearance', exact: true, wait: 900 });
    if (mode) await act({ click: mode, wait: 700 });
    if (surface) await act({ click: SURF[surface], wait: 700 });
    if (accent) await act({ click: accent, wait: 700 });
    if (size) await act({ click: size, wait: 700 });
    if (layout) { await act({ text: 'Layout', exact: true, wait: 700 }); await act({ click: layout, wait: 900 }); }
  }
  for (const s of shot.steps) await act(s);
  await page.mouse.move(1100, 880);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${name}.jpg`), type: 'jpeg', quality: 90 });
  console.log('ok', name);
  await page.close();
}
await browser.close();
