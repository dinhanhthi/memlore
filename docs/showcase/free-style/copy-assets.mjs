// Copy fonts, logos, stickers, the world map and Lucide icons into the shared
// docs/showcase/assets/ folder (used by every showcase film), and KaTeX into vendor/.
//   node docs/showcase/free-style/copy-assets.mjs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../../..');
const assets = path.resolve(dir, '../assets');
const require = createRequire(path.join(root, 'package.json'));
const pkg = name => path.dirname(require.resolve(`${name}/package.json`));
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };

for (const [p, files] of Object.entries({
  '@fontsource-variable/fraunces': ['fraunces-latin-wght-normal.woff2', 'fraunces-latin-wght-italic.woff2', 'fraunces-vietnamese-wght-normal.woff2'],
  '@fontsource-variable/geist': ['geist-latin-wght-normal.woff2'],
  '@fontsource-variable/geist-mono': ['geist-mono-latin-wght-normal.woff2'],
  '@fontsource-variable/baloo-2': ['baloo-2-latin-wght-normal.woff2'],
})) for (const f of files) cp(path.join(pkg(p), 'files', f), path.join(assets, 'fonts', f));

const katex = path.join(pkg('katex'), 'dist');
cp(path.join(katex, 'katex.min.js'), path.join(dir, 'vendor/katex/katex.min.js'));
cp(path.join(katex, 'katex.min.css'), path.join(dir, 'vendor/katex/katex.min.css'));
for (const f of fs.readdirSync(path.join(katex, 'fonts'))) if (f.endsWith('.woff2')) cp(path.join(katex, 'fonts', f), path.join(dir, 'vendor/katex/fonts', f));

const pub = path.join(root, 'public');
cp(path.join(pub, 'logo-without-container/logo.png'), path.join(assets, 'logo.png'));
cp(path.join(pub, 'logo-without-container/logo-straight-close-eyes-1048.png'), path.join(assets, 'logo-blink.png'));
cp(path.join(pub, 'logo-without-container/logo-straight-1126.png'), path.join(assets, 'logo-straight.png'));
cp(path.join(pub, 'logo-with-container/logo-iOS-Default-512x512@1x.png'), path.join(assets, 'appicon.png'));
for (const f of fs.readdirSync(path.join(pub, 'head-rotate'))) cp(path.join(pub, 'head-rotate', f), path.join(assets, 'head', f));
for (const f of fs.readdirSync(path.join(pub, 'stickers'))) cp(path.join(pub, 'stickers', f), path.join(assets, 'stickers', f));

const land = fs.readFileSync(path.join(root, 'website/src/naturalEarthLand.ts'), 'utf8').match(/'(M[^']+)'/)[1];
fs.writeFileSync(path.join(assets, 'land.js'), `// Natural Earth 110m land, equirectangular viewBox 0 0 360 180 (public domain).\nwindow.LAND_D = '${land}';\n`);
console.log('assets copied');

// Lucide icons (the set the app itself uses) → ../assets/icons.js as { name: [[tag, attrs], …] }.
const ICONS = ['lock', 'lock-open', 'shield-check', 'wifi', 'wifi-off', 'cloud', 'cloud-off', 'server', 'check', 'sparkles',
  'search', 'calendar', 'tag', 'image', 'mic', 'video', 'map-pin', 'fingerprint-pattern', 'eye-off', 'eye', 'laptop', 'key-round',
  'database', 'file-text', 'download', 'upload', 'git-branch', 'message-circle', 'brain', 'pen-line', 'bold', 'italic',
  'highlighter', 'list-checks', 'code', 'sigma', 'heading', 'table', 'smile', 'meh', 'frown', 'wand-sparkles', 'lightbulb',
  'quote', 'repeat', 'plug', 'terminal', 'monitor', 'smartphone', 'refresh-cw', 'x', 'plus', 'user-round', 'heart',
  'palette', 'layout-panel-left', 'sun', 'moon', 'history', 'star', 'hard-drive', 'cpu', 'arrow-right', 'chart-column',
  'book-open', 'feather', 'link', 'underline', 'strikethrough', 'type', 'send', 'folder-open', 'file-json', 'calendar-days', 'layers'];
const iconsDir = path.join(pkg('lucide-react'), 'dist', 'esm', 'icons');
const icons = {};
for (const n of ICONS) {
  let file = path.join(iconsDir, `${n}.js`);
  if (!fs.existsSync(file)) { console.log('missing icon', n); continue; }
  let src = fs.readFileSync(file, 'utf8');
  const alias = !src.includes('__iconNode') && src.match(/from '\.\/([\w-]+\.js)'/);
  if (alias) src = fs.readFileSync(path.join(iconsDir, alias[1]), 'utf8');
  const node = src.match(/const __iconNode = (\[[\s\S]*?\]);\n/)[1];
  icons[n] = Function(`return ${node}`)().map(([tag, attrs]) => { const { key, ...rest } = attrs; return [tag, rest]; });
}
fs.writeFileSync(path.join(assets, 'icons.js'), `// Lucide icons (ISC licence), extracted by copy-assets.mjs.\nwindow.ICONS = ${JSON.stringify(icons)};\n`);
console.log('icons', Object.keys(icons).length);
