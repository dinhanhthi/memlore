// Final soundtrack for the free-style film: voice-over + music + cut accents → audio.wav.
//
//   node docs/showcase/free-style-vi/mix.mjs
//
// 1. voice.wav: every line from voice-vi/manifest.json placed at sceneStart + toOutput(at)
//    (`at` from voice-vi/at.json, written by fit.mjs, merged over the narration lines).
// 2. Music: music/music.mp3 (ElevenLabs, music.mjs) plus sfx.wav (soundtrack.py --stem sfx);
//    without music.mp3 it falls back to soundtrack.wav, which already holds its own accents.
//    The synthesized stem is rebuilt on every run (free, ~10 s), and music.mp3 is only used when
//    its chapter durations (music/music.json) still match the timeline, so no accent or chapter
//    change can drift off the picture cuts.
// 3. The music sits at MUSIC_GAIN and ducks under the voice (sidechain), the last FADE seconds
//    fade out, and the whole mix is normalised to −14 LUFS and cut to exactly the film length.
// render.mjs muxes audio.wav when it exists. Needs ffmpeg + ffprobe.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';
import config from './config.mjs';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const f = p => path.join(dir, p);
const read = p => JSON.parse(fs.readFileSync(f(p), 'utf8'));
const sandbox = {};
vm.runInNewContext(fs.readFileSync(f('timing.js'), 'utf8'), sandbox);
const lay = sandbox.Timing.layout(read(config.timeline));
const DUR = lay.dur, SR = 44100, FADE = 1.5;
// levels approved with the sample-2 preview
const MUSIC_GAIN = 0.45, SFX_GAIN = 0.5, DUCK = 'threshold=0.02:ratio=6:attack=15:release=500:knee=4';
const ff = args => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

// ── 1. voice track ──
const nar = JSON.parse(fs.readFileSync(path.resolve(dir, config.narration), 'utf8')), man = read(`${config.voiceDir}/manifest.json`);
if (man.estimated) {
  console.error(`mix.mjs: ${config.voiceDir}/manifest.json is an ESTIMATE (estimate-voice.mjs), not real voice audio. Refusing to mix.\nRun voice.mjs --i-am-sure first; it replaces the estimate.`);
  process.exit(1);
}
const atJson = fs.existsSync(f(`${config.voiceDir}/at.json`)) ? read(`${config.voiceDir}/at.json`) : {};
const placed = [];
for (const s of lay.scenes) {
  const lines = man.lines[s.id] || [];
  const ats = [].concat(atJson[s.id] ?? nar.scenes.find(x => x.id === s.id)?.at ?? []);
  lines.forEach((l, k) => {
    if (ats[k] == null) throw new Error(`${s.id}#${k} has no "at" — run fit.mjs --write`);
    const t = s.start + s.toOutput(ats[k]);
    if (t + l.dur > s.start + s.outDur + 1e-6) throw new Error(`${s.id}#${k} runs past its scene — run fit.mjs`);
    placed.push({ file: f(`${config.voiceDir}/${l.file}`), t });
  });
}
const vIn = placed.flatMap(p => ['-i', p.file]);
const vFc = placed.map((p, i) => `[${i}:a]aresample=${SR},aformat=channel_layouts=stereo,adelay=${Math.round(p.t * 1000)}:all=1[v${i}]`).join(';')
  + ';' + placed.map((_, i) => `[v${i}]`).join('') + `amix=inputs=${placed.length}:normalize=0:dropout_transition=0,apad=whole_dur=${DUR},atrim=0:${DUR}[o]`;
ff([...vIn, '-filter_complex', vFc, '-map', '[o]', '-ar', String(SR), f('voice.wav')]);

// ── 2 + 3. music bed, accents, ducking, master ──
const hasMusic = fs.existsSync(f(`${config.musicDir}/music.mp3`));
if (hasMusic) {
  // chapter durations the score was generated for vs the current timeline
  const plan = read('music-plan.json'), side = fs.existsSync(f(`${config.musicDir}/music.json`)) ? read(`${config.musicDir}/music.json`) : null;
  const order = plan.chapters.flatMap(ch => ch.scenes).join(' '), ids = lay.scenes.map(s => s.id).join(' ');
  if (order !== ids) throw new Error(`music-plan.json chapters no longer match the timeline scenes — update the plan, then re-run: node music.mjs\n  plan:     ${order}\n  timeline: ${ids}`);
  const want = plan.chapters.map(ch => Math.round(ch.scenes.reduce((n, id) => n + (lay.scenes.find(s => s.id === id)?.outDur ?? NaN), 0) * 1000));
  const got = side ? side.sections.map(s => s.duration_ms) : [];
  if (want.join() !== got.join()) throw new Error(`music/music.mp3 was generated for chapters [${got.join(', ')}] ms, the timeline now needs [${want.join(', ')}] ms — re-run: node music.mjs`);
  const planSha = crypto.createHash('sha1').update(fs.readFileSync(f('music-plan.json'))).digest('hex');
  if (side.planSha !== planSha) console.warn('note: music-plan.json changed since music.mp3 was generated (timing still matches) — re-run node music.mjs to hear the new styles');
}
const music = hasMusic ? f(`${config.musicDir}/music.mp3`) : f('soundtrack.wav');
const withSfx = hasMusic;
execFileSync('python3', [f('soundtrack.py'), ...(withSfx ? ['--stem', 'sfx', '--out', f('sfx.wav')] : ['--out', f('soundtrack.wav')])], { stdio: ['ignore', 'ignore', 'inherit'] });
const fit = `aresample=${SR},aformat=channel_layouts=stereo,apad=whole_dur=${DUR},atrim=0:${DUR}`;
const inputs = ['-i', music, '-i', f('voice.wav'), ...(withSfx ? ['-i', f('sfx.wav')] : [])];
const fc = [
  `[0:a]${fit},volume=${MUSIC_GAIN}[mu]`,
  `[1:a]${fit},asplit=2[vo][sc]`,
  `[mu][sc]sidechaincompress=${DUCK}[duck]`,
  withSfx ? `[2:a]${fit},volume=${SFX_GAIN}[fx]` : null,
  `[duck][vo]${withSfx ? '[fx]' : ''}amix=inputs=${withSfx ? 3 : 2}:normalize=0,afade=t=out:st=${DUR - FADE}:d=${FADE},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=${SR},atrim=0:${DUR}[o]`,
].filter(Boolean).join(';');
ff([...inputs, '-filter_complex', fc, '-map', '[o]', '-ar', String(SR), '-c:a', 'pcm_s16le', f(config.audio)]);

// ── checks: exact length, never silent before the fade ──
const probe = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f(config.audio)]).toString());
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', f(config.audio), '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
const x = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
let quiet = null, minDb = 0;
// the generated Vietnamese score ends ~2.5 s before the film does (its final chord is gone by ~238 s of 240.5 s),
// so the last TAIL seconds are near-silent by design: they only have to stay above TAIL_DB (a real dropout such as a
// truncated score is still caught), the body of the film must stay above -40 dBFS
const TAIL = 3, BODY_DB = -40, TAIL_DB = -60;
for (let s = 0; s + 1 <= DUR - FADE; s++) {
  let e = 0; for (let i = s * SR; i < (s + 1) * SR; i++) e += x[i] * x[i];
  const db = 10 * Math.log10(e / SR + 1e-12);
  if (db < minDb) minDb = db;
  if (db < (s + 1 <= DUR - TAIL ? BODY_DB : TAIL_DB) && quiet == null) quiet = s;
}
console.log(`audio.wav: ${probe.toFixed(2)} s (film ${DUR} s) · ${placed.length} voice lines · music: ${path.relative(dir, music)}${withSfx ? ' + sfx.wav' : ''} · quietest second ${minDb.toFixed(1)} dBFS`);
if (Math.abs(probe - DUR) > 0.05) throw new Error('audio.wav length does not match the film');
if (quiet != null) throw new Error(`audio drops below ${quiet + 1 <= DUR - TAIL ? BODY_DB : TAIL_DB} dBFS at ${quiet} s`);
