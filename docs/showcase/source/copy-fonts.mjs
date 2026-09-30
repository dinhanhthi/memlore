// Refresh the shared ../assets/fonts/ from the app's self-hosted variable fonts (latin + vietnamese subsets).
//   node docs/showcase/source/copy-fonts.mjs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import url from 'url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const req = createRequire(path.resolve(here, '../../../package.json'));
const out = path.resolve(here, '../assets/fonts');
fs.mkdirSync(out, { recursive: true });
for (const pkg of ['@fontsource-variable/fraunces', '@fontsource-variable/geist', '@fontsource-variable/geist-mono']) {
  const dir = path.join(path.dirname(req.resolve(pkg + '/package.json')), 'files');
  for (const f of fs.readdirSync(dir)) {
    if (/(latin|vietnamese)-(wght|full)-normal\.woff2$/.test(f) && !f.includes('latin-ext')) {
      fs.copyFileSync(path.join(dir, f), path.join(out, f));
      console.log(f);
    }
  }
}
