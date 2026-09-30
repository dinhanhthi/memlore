// Free stand-in for voice.mjs: estimates voice-vi/manifest.json and voice-vi/at.json from the
// narration text alone (no ElevenLabs, no audio), so scenes can be laid out and checked before any
// credits are spent.
//
//   node docs/showcase/free-style-vi/estimate-voice.mjs
//
// The manifest has the real shape plus a top-level "estimated": true (file is null); fit.mjs
// refuses to run on it and voice.mjs replaces it. A real (non-estimated) manifest is never overwritten.
import fs from 'fs';
import path from 'path';
import url from 'url';
import config from './config.mjs';

const CHARS_PER_SEC = 14; // estimated speaking rate: line duration = characters / this
const LEAD_IN = 0.5; // s of silence before the first word of a line
const FIRST_AT = 0.7, GAP = 0.3; // first line start / gap after the previous line's end (s)

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const out = path.join(dir, config.voiceDir);
const manPath = path.join(out, 'manifest.json');
if (fs.existsSync(manPath) && !JSON.parse(fs.readFileSync(manPath, 'utf8')).estimated) {
  console.error(`estimate-voice.mjs: ${config.voiceDir}/manifest.json is a real voice manifest; refusing to overwrite it.`);
  process.exit(1);
}

const r3 = x => Math.round(x * 1000) / 1000;
const nar = JSON.parse(fs.readFileSync(path.resolve(dir, config.narration), 'utf8'));
const lines = {}, at = {};
for (const s of nar.scenes) {
  const vo = Array.isArray(s.vo) ? s.vo : s.vo ? [s.vo] : [];
  if (!vo.length) continue;
  let t = FIRST_AT;
  const ats = [];
  lines[s.id] = vo.map(text => {
    const dur = text.length / CHARS_PER_SEC;
    const ws = text.split(/\s+/).filter(Boolean), total = ws.reduce((n, w) => n + w.length, 0);
    let acc = 0;
    const words = ws.map(w => { const e = { w, t: r3(LEAD_IN + (acc / total) * (dur - LEAD_IN)) }; acc += w.length; return e; });
    ats.push(r3(t));
    t += dur + GAP;
    return { file: null, text, dur: r3(dur), words };
  });
  at[s.id] = Array.isArray(s.vo) ? ats : ats[0];
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(manPath, JSON.stringify({ estimated: true, voice: config.voice, tempo: config.voice.tempo, lines }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'at.json'), JSON.stringify(at, null, 2) + '\n');
const total = Object.values(lines).flat().reduce((n, l) => n + l.dur, 0);
console.log(`estimated ${Object.values(lines).flat().length} lines, ${total.toFixed(1)} s of speech -> ${config.voiceDir}/manifest.json + at.json`);
