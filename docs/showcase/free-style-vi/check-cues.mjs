// Check every cue phrase in texts.vi.json against the REAL Quang Toan voice timing.
//
//   node docs/showcase/free-style-vi/check-cues.mjs
//
// For each `<scene>.cue.<key>` prints the scene-local source second where the phrase is spoken, or
// UNRESOLVED (the picture would then fall back to the line start). Exit 1 when anything is
// unresolved. Refuses to run on a missing or estimated manifest. Reads only; writes nothing.
import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';
import config from './config.mjs';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const die = msg => { console.error(`check-cues.mjs: ${msg}`); process.exit(1); };
const readJson = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// Same matching as `norm` / `cue` in lib.js. The assert below fails when lib.js changes its norm().
const NORM_SRC = "const norm = w => w.toLowerCase().replace(/[^a-z0-9\\u00c0-\\u024f\\u1e00-\\u1eff']/g, '');";
if (!fs.readFileSync(path.join(dir, 'lib.js'), 'utf8').includes(NORM_SRC)) die('norm() in lib.js changed; update this copy to match.');
const norm = w => w.toLowerCase().replace(/[^a-z0-9À-ɏḀ-ỿ']/g, '');
function find(words, phrase) {
  const want = phrase.split(/\s+/).map(norm).filter(Boolean);
  if (!want.length) return -1;
  for (let i = 0; i + want.length <= words.length; i++) if (want.every((w, j) => norm(words[i + j].w) === w)) return i;
  return -1;
}

// Which voice line each scene's cues search (the k passed to cueT in scenes/*.js): 0 everywhere
// except the Daily Chat card of aiCards. Keep in sync with scenes/ai.js.
const LINE = { aiCards: 8 };

const manPath = path.join(dir, config.voiceDir, 'manifest.json');
if (!fs.existsSync(manPath)) die(`${config.voiceDir}/manifest.json is missing. Run voice.mjs --i-am-sure first.`);
const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
if (man.estimated) die(`${config.voiceDir}/manifest.json is an ESTIMATE, not real voice timing. Run voice.mjs --i-am-sure first.`);
const atPath = path.join(dir, config.voiceDir, 'at.json');
if (!fs.existsSync(atPath)) die(`${config.voiceDir}/at.json is missing. Run fit.mjs --write first.`);
const at = JSON.parse(fs.readFileSync(atPath, 'utf8'));
const texts = readJson(config.texts), tl = readJson(config.timeline);
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(dir, 'timing.js'), 'utf8'), sandbox);
const { Timing } = sandbox;

let total = 0, bad = 0;
for (const [scene, block] of Object.entries(texts)) {
  if (!block || typeof block !== 'object' || !block.cue) continue;
  const sc = tl.scenes.find(s => s.id === scene);
  const lines = man.lines[scene] || [];
  const k = LINE[scene] ?? 0, ln = lines[k];
  const ats = [].concat(at[scene] ?? []);
  console.log(`${scene}${lines.length > 1 ? ` (line ${k})` : ''}`);
  for (const [key, phrase] of Object.entries(block.cue)) {
    total++;
    const i = ln ? find(ln.words || [], phrase) : -1;
    if (i < 0 || !sc) {
      bad++;
      console.log(`  UNRESOLVED  ${key}: "${phrase}"`);
      console.log(`      line: ${ln ? ln.text : '(no voice line ' + k + ')'}`);
      if (ln) console.log(`      words: ${(ln.words || []).map(x => x.w).join(' | ')}`);
      continue;
    }
    // scene-local source seconds, as film.js computes them (word start -> output -> source)
    const m = Timing.sceneMap(sc, tl.bpm);
    const s = m.toSource(m.toOutput(ats[k] ?? 0) + ln.words[i].t);
    console.log(`  ${s.toFixed(2).padStart(7)} s  ${key}: "${phrase}"`);
  }
}
console.log(`${total - bad}/${total} cues resolved${bad ? `, ${bad} UNRESOLVED (edit texts.vi.json)` : ''}`);
process.exit(bad ? 1 : 0);
