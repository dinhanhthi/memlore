// Capture the real app screens the film uses, from the website demo.
//
//   pnpm website:dev                              (serves the demo on :5176, repo root)
//   node docs/showcase/v2/source/shoot.mjs        -> docs/showcase/assets/shots/v2/*.jpg (1440x900 @2x)
//
// The demo runs in a same-origin iframe so its bridge accepts theme / navigate commands.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.resolve(here, '../../../../package.json'))('@playwright/test');
const outDir = path.resolve(here, '../../assets/shots/v2');
fs.mkdirSync(outDir, { recursive: true });

const AWAY = [1100, 500]; // park the pointer so no tooltip shows
const PLAN = [
  { name: 'sig-write', ds: 'signature', steps: [{ nav: 'write', wait: 2500 }, { mouse: AWAY }] },
  { name: 'sig-search', steps: [{ click: 'Search', wait: 800 }, { type: 'morning', wait: 2000 }] },
  { name: 'sig-lookback', steps: [{ key: 'Escape', wait: 800 }, { click: 'Lookback', wait: 1800 }] },
  { name: 'sig-gallery', steps: [{ click: 'Gallery', wait: 2500 }, { mouse: [1435, 5] }] },
  { name: 'sig-stats', steps: [{ click: 'Statistics', wait: 2500 }, { mouse: AWAY }] },
  { name: 'sig-chat', steps: [{ nav: 'chat', wait: 1500 }, { text: 'Morning reflections', wait: 2500 }] },
  { name: 'sig-sync', steps: [{ click: 'Settings', last: true, wait: 1500 }, { text: 'Sync', exact: true, wait: 1800 }, { mouse: AWAY }] },
  { name: 'clean-light', ds: 'clean', steps: [{ nav: 'write', wait: 1500 }, { click: 'Toggle theme' }, { mouse: AWAY }] },
  { name: 'clay-light', ds: 'clay', steps: [{ wait: 2000 }] },
  { name: 'clay-dark', steps: [{ click: 'Toggle theme' }, { mouse: AWAY }] },
  { name: 'sig-light', ds: 'signature', steps: [{ click: 'Toggle theme' }, { mouse: AWAY }] },
  { name: 'sig-lock', steps: [{ click: 'Toggle theme', wait: 800 }, { click: 'Lock app', wait: 2500 }] },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5176/privacy.html', { waitUntil: 'networkidle' });
await page.evaluate(() => {
  const f = document.createElement('iframe');
  f.id = 'f';
  f.src = '/demo.html';
  f.style.cssText = 'position:fixed;inset:0;width:1440px;height:900px;border:0';
  document.body.replaceChildren(f);
  document.body.style.margin = '0';
});
await page.waitForTimeout(4000);
const frame = page.frameLocator('#f');
const send = (cmd) =>
  page.evaluate((c) => document.getElementById('f').contentWindow.postMessage({ type: 'memlore-demo-command', version: 1, ...c }, location.origin), cmd);
const button = (name) => frame.getByRole('button', { name, exact: true }).or(frame.getByRole('link', { name, exact: true }));

for (const shot of PLAN) {
  if (shot.ds) {
    await send({ command: 'theme', designSystem: shot.ds });
    await page.waitForTimeout(600);
  }
  for (const s of shot.steps) {
    try {
      if (s.nav) await send({ command: 'navigate', view: s.nav });
      if (s.click) await (s.last ? button(s.click).last() : button(s.click).first()).click({ timeout: 3000 });
      if (s.text) await frame.getByText(s.text, { exact: !!s.exact }).first().click({ timeout: 3000 });
      if (s.mouse) await page.mouse.move(...s.mouse);
      if (s.key) await page.keyboard.press(s.key);
      if (s.type) await page.keyboard.type(s.type, { delay: 20 });
    } catch (e) {
      console.log('fail', shot.name, JSON.stringify(s), e.message.split('\n')[0]);
    }
    await page.waitForTimeout(s.wait ?? 1500);
  }
  await page.screenshot({ path: path.join(outDir, `${shot.name}.jpg`), type: 'jpeg', quality: 90 });
  console.log('ok', shot.name);
}
await browser.close();
