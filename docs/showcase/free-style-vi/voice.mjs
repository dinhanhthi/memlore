// Voice-over for the free-style film, via ElevenLabs text-to-speech (with timestamps).
//
//   ELEVENLABS_API_KEY=… node docs/showcase/free-style-vi/voice.mjs --i-am-sure          # generate missing lines
//   ELEVENLABS_API_KEY=… node docs/showcase/free-style-vi/voice.mjs --i-am-sure --force  # regenerate everything
//
// Reads the narration named in config.mjs (read only), writes one mp3 per line to voice-vi/ (named
// by a hash of text + voice + model + settings, so only edited lines are re-generated) and
// voice-vi/manifest.json with each line's file and spoken duration. The voice comes from config.mjs.
// The key is read from the environment only; never commit it.
// eleven_v4 ignores voice_settings.speed, so config.mjs `voice.tempo` speeds the cached
// `.raw.mp3` up afterwards with ffmpeg atempo (pitch kept); changing it costs no credits.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';
import config from './config.mjs';

// Safety: this script can spend ElevenLabs credits, so it refuses to run without --i-am-sure.
// The check runs before anything reads the key or touches the network.
if (!process.argv.includes('--i-am-sure')) {
  console.error('voice.mjs: refusing to run. It calls the paid ElevenLabs API and writes cache files.\nRe-run with --i-am-sure once you really mean it.');
  process.exit(1);
}

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const out = path.join(dir, config.voiceDir);
const force = process.argv.includes('--force');
const key = process.env.ELEVENLABS_API_KEY; // only needed when a line has to be generated

const nar = JSON.parse(fs.readFileSync(path.resolve(dir, config.narration), 'utf8'));
const { voice_id: voiceId, model_id: modelId, tempo = 1, settings, language_code: languageCode } = config.voice;
fs.mkdirSync(out, { recursive: true });

const lines = nar.scenes.flatMap(s => (Array.isArray(s.vo) ? s.vo : s.vo ? [s.vo] : []).map((text, k) => ({ id: s.id, k, text })));
const manifest = {};
// word starts (output seconds, after tempo) from ElevenLabs' per-character alignment, so scenes
// can cue a visual beat on a spoken word (lib.js cue())
function wordTimes({ characters: ch = [], character_start_times_seconds: st = [] } = {}) {
  const out = [];
  let w = '', t0 = 0;
  const flush = () => { if (w.trim()) out.push({ w: w.trim(), t: Math.round((t0 / tempo) * 1000) / 1000 }); w = ''; };
  ch.forEach((c, i) => { if (/\s/.test(c)) flush(); else { if (!w) t0 = st[i]; w += c; } });
  flush();
  return out;
}
let chars = 0;
for (const [i, ln] of lines.entries()) {
  const hash = crypto.createHash('sha1').update(JSON.stringify([ln.text, voiceId, modelId, settings, ...(languageCode ? [languageCode] : [])])).digest('hex').slice(0, 10);
  const file = `${ln.id}-${ln.k}-${hash}.mp3`;
  const raw = path.join(out, file.replace(/\.mp3$/, '.raw.mp3'));
  const meta = path.join(out, file.replace(/\.mp3$/, '.json'));
  if (!fs.existsSync(raw) && fs.existsSync(path.join(out, file)) && fs.existsSync(meta)) fs.renameSync(path.join(out, file), raw); // older cache layout
  if (force || !fs.existsSync(meta) || !fs.existsSync(raw)) {
    if (!key) throw new Error(`ELEVENLABS_API_KEY is not set (needed to generate ${file})`);
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      // neighbouring lines keep the intonation continuous across separate requests
      body: JSON.stringify({ text: ln.text, model_id: modelId, language_code: languageCode, voice_settings: settings, previous_text: lines[i - 1]?.text, next_text: lines[i + 1]?.text }),
    });
    if (!res.ok) throw new Error(`${ln.id}#${ln.k}: HTTP ${res.status} ${await res.text()}`);
    const j = await res.json();
    fs.writeFileSync(raw, Buffer.from(j.audio_base64, 'base64'));
    const ends = j.alignment.character_end_times_seconds;
    fs.writeFileSync(meta, JSON.stringify({ text: ln.text, dur: ends[ends.length - 1], alignment: j.alignment }) + '\n');
    chars += ln.text.length;
    console.log(`generated ${file}`);
  }
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-filter:a', `atempo=${tempo}`, '-b:a', '160k', path.join(out, file)]);
  const cached = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const dur = cached.dur / tempo;
  (manifest[ln.id] ||= []).push({ file, text: ln.text, dur: Math.round(dur * 1000) / 1000, words: wordTimes(cached.alignment) });
}
// drop mp3/json files no longer referenced
const keep = new Set(Object.values(manifest).flat().flatMap(l => [l.file, l.file.replace(/\.mp3$/, '.json'), l.file.replace(/\.mp3$/, '.raw.mp3')]));
for (const f of fs.readdirSync(out)) if (f !== 'manifest.json' && f !== 'at.json' && !keep.has(f)) fs.unlinkSync(path.join(out, f));
// a real run replaces an estimated manifest (estimate-voice.mjs) outright, and drops the estimated at.json with it
const manPath = path.join(out, 'manifest.json');
if (fs.existsSync(manPath) && JSON.parse(fs.readFileSync(manPath, 'utf8')).estimated) fs.rmSync(path.join(out, 'at.json'), { force: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ voice: config.voice, tempo, lines: manifest }, null, 2) + '\n');
const total = Object.values(manifest).flat().reduce((n, l) => n + l.dur, 0);
console.log(`${lines.length} lines, ${total.toFixed(1)} s of speech, ${chars} characters billed this run`);
