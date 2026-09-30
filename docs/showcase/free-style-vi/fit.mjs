// Fit the timeline to the voice-over.
//
//   node docs/showcase/free-style-vi/fit.mjs           # report only
//   node docs/showcase/free-style-vi/fit.mjs --write   # write `at` into voice-vi/at.json, resize scenes
//
// Each narration line gets `at` (written to voice-vi/at.json; the narration file is never written), its start in scene-local SOURCE seconds: the first line starts
// after the enter transition (LEAD), later lines follow the previous one with GAP (the hook's
// four words run tighter, and its picture follows them). aiCards lines are one card each: a card
// lasts its line plus CARD_PAD, never less than CARD_MIN, so a long line (Daily Chat) gets a long
// card. A scene lasts until its last word + TAIL (a short pause, per-scene override), or MIN
// seconds when its picture needs longer; --write sets that length on the 0.5 s beat grid
// (`beats`, with `bars` = the source length that covers it), raising or lowering it.
// Scenes with `speed`/`warp` keep their hand-set length and are only reported.
import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';
import config from './config.mjs';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const write = process.argv.includes('--write');
const LEAD = 0.7, GAP = 0.25, CARD_MIN = 3.2, CARD_PAD = 0.9;
const TAIL = { default: 0.6, intro: 0.3, hook: 0.4 }; // pause after the last word (s)
// scenes whose picture must run longer than their speech (output s): the outro needs the click,
// confetti and the fade to black after its last word; map its five stops; onThisDay and secondYou
// a short hold on their last beat; calendar and tags their legend / eight rows
const MIN = { outro: 9, map: 10, onThisDay: 7, secondYou: 8.5, calendar: 5.5, tags: 6 };
const GRID_HOLD = 3.5; // aiCards: the closing grid stays this long after its line starts
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(dir, 'timing.js'), 'utf8'), sandbox);
const { Timing } = sandbox;

const nar = JSON.parse(fs.readFileSync(path.resolve(dir, config.narration), 'utf8')), tl = read(config.timeline), man = read(`${config.voiceDir}/manifest.json`);
if (man.estimated) {
  console.error(`fit.mjs: ${config.voiceDir}/manifest.json is an ESTIMATE (estimate-voice.mjs), not real voice timing. Refusing to fit.\nRun voice.mjs --i-am-sure first; it replaces the estimate.`);
  process.exit(1);
}
const atOut = {}; // { sceneId: number | number[] } -> voice-vi/at.json
const PACE = { hook: { lead: 0.1, gap: 0.15 } }; // per-scene LEAD / GAP overrides
let bad = 0;
const rows = [];
for (const sc of tl.scenes) {
  const n = nar.scenes.find(s => s.id === sc.id), lines = man.lines[sc.id] || [];
  if (!n || !lines.length) { rows.push([sc.id, '-', '-', sc.bars, sc.bars, '']); continue; }
  const m = Timing.sceneMap(sc, tl.bpm);
  const at = [];
  const { lead = LEAD, gap = GAP } = PACE[sc.id] || {};
  const cards = sc.id === 'aiCards';
  lines.forEach((_, k) => {
    if (k === 0) at.push(cards ? 0.3 : lead);
    else if (cards) at.push(at[k - 1] + Math.max(CARD_MIN, lines[k - 1].dur + CARD_PAD));
    else at.push(m.toSource(m.toOutput(at[k - 1]) + lines[k - 1].dur + gap));
  });
  // overlap check for fixed-position lines
  const overlap = lines.some((_, k) => k && m.toOutput(at[k]) < m.toOutput(at[k - 1]) + lines[k - 1].dur);
  const end = m.toOutput(at[at.length - 1]) + lines[lines.length - 1].dur; // output seconds
  const warped = sc.speed != null || (sc.warp && sc.warp.length); // remapped time: hand-set length
  const tail = TAIL[sc.id] ?? TAIL.default, beat = 60 / tl.bpm;
  const want = Math.max(end + tail, MIN[sc.id] ?? 0, cards ? m.toOutput(at[at.length - 1]) + GRID_HOLD : 0); // output seconds
  let bars = sc.bars, note = '';
  if (warped) {
    if (end + tail > m.outDur + 1e-9) { note = 'TOO SHORT (warped, resize by hand)'; bad++; }
  } else {
    const beats = Math.ceil(want / beat - 1e-9);
    const len = beats * beat;
    if (Math.abs(len - m.outDur) > 1e-9) {
      note = `${m.outDur.toFixed(1)} → ${len.toFixed(1)} s`;
      if (write) {
        bars = sc.bars = Math.ceil(beats / 4);
        if (beats === bars * 4) delete sc.beats; else sc.beats = beats;
      } else bad++;
    }
  }
  if (overlap) { note += ' LINES OVERLAP'; bad++; }
  atOut[sc.id] = Array.isArray(n.vo) ? at.map(x => Math.round(x * 1000) / 1000) : Math.round(at[0] * 1000) / 1000;
  rows.push([sc.id, at[0].toFixed(2), end.toFixed(2), m.outDur.toFixed(1), bars, note]);
}
console.log('scene       firstAt  speechEnd  sceneLen  bars  note');
for (const [id, a, e, len, b, note] of rows) console.log(`${id.padEnd(11)} ${String(a).padStart(7)} ${String(e).padStart(10)} ${String(len).padStart(9)} ${String(b).padStart(5)}  ${note}`);
if (write) {
  fs.writeFileSync(path.join(dir, config.voiceDir, 'at.json'), JSON.stringify(atOut, null, 2) + '\n');
  // one scene per line, like the hand-written file
  const sceneLine = sc => '    { ' + Object.entries(sc).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + ' }';
  fs.writeFileSync(path.join(dir, config.timeline), `{\n  "bpm": ${tl.bpm},\n  "note": ${JSON.stringify(tl.note)},\n  "scenes": [\n${tl.scenes.map(sceneLine).join(',\n')}\n  ]\n}\n`);
}
console.log(`film: ${Timing.layout(tl).dur} s`);
if (bad) process.exitCode = 1; // --write fixes short bars itself; warped scenes and overlaps stay errors
