// Vietnamese voice audition for the free-style film: the same excerpt read by several ElevenLabs voices.
//
//   ELEVENLABS_API_KEY=… node docs/showcase/free-style/audition.mjs        # generate missing lines + audition/index.html
//   node docs/showcase/free-style/audition.mjs --dry                       # print the plan, no request, no key needed
//
// Reads narration.vi.json, takes the lines of scenes intro, hook, locks and mcp and, for every
// candidate voice, writes audition/<voice-slug>-<scene>-<k>.mp3 plus a listening page
// audition/index.html (one section per line, one row per voice). Raw mp3s are cached in audition/
// by a hash of text + voice + model + settings, so re-runs cost nothing. The model is the first of
// eleven_v4, eleven_multilingual_v2 that lists Vietnamese in GET /v1/models. The key is read from
// the environment only; never commit it. `voice.tempo` speeds the cached raw mp3 up with ffmpeg atempo.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const out = path.join(dir, 'audition');
const dry = process.argv.includes('--dry');
const key = process.env.ELEVENLABS_API_KEY;
const api = 'https://api.elevenlabs.io';

const voices = [
  { name: 'Quang Toan', id: 'ZsjEJaLQy3sgvwxicmDx' },
  { name: 'Vo HuuNhan', id: '0ie70vBIPQXddQI95OFn' },
  { name: 'Viet', id: 'QGMQQ6AeojXOsajaB41T' },
  { name: 'Minh Trung (quang cao)', id: 'IGtlBHdBES5Eg7GWNRLm' },
  { name: 'Tuyết (quang cao)', id: 'xPEfmymXC4WdBxGMznS7' },
  { name: 'Trieu Duong', id: 'UsgbMVmY3U59ijwK5mdh' },
  { name: 'Duc Huy', id: 'w2KTJ6MO4SIK6nWK4YH8' },
];
const slug = n => n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// per-voice problems only; bad key (401), no credits (402), rate limit (429), 5xx and other 4xx stay fatal
const voiceUnavailable = (status, body, id) =>
  status === 403 || status === 404 || ([400, 422].includes(status) && (body.includes(id) || /voice_not_found/.test(body)));

const nar = JSON.parse(fs.readFileSync(path.join(dir, 'narration.vi.json'), 'utf8'));
const { tempo = 1 } = nar.voice;
if (!(Number.isFinite(tempo) && tempo > 0)) throw new Error(`voice.tempo must be a positive number, got ${tempo}`);
const settings = { stability: 0.15, similarity_boost: 0.75, style: 0.55, use_speaker_boost: true, speed: 1.12 };
const excerpt = ['intro', 'hook', 'locks', 'mcp'];
const lines = nar.scenes
  .filter(s => excerpt.includes(s.id))
  .flatMap(s => (Array.isArray(s.vo) ? s.vo : s.vo ? [s.vo] : []).map((text, k) => ({ id: s.id, k, text })));
const lineChars = lines.reduce((n, l) => n + l.text.length, 0);

if (dry) {
  console.log(`Audition plan (dry run, no request): scenes ${excerpt.join(', ')}`);
  console.log(`${voices.length} voices:`);
  for (const v of voices) console.log(`  ${v.name}  ${v.id}`);
  console.log(`${lines.length} lines per voice, tempo ${tempo}`);
  console.log(`~${lineChars} characters per voice, ~${lineChars * voices.length} characters in total if nothing is cached`);
  process.exit(0);
}
if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
const headers = { 'xi-api-key': key };

// (a) model: first candidate that lists Vietnamese
const mres = await fetch(`${api}/v1/models`, { headers });
if (!mres.ok) throw new Error(`GET /v1/models: HTTP ${mres.status} ${await mres.text()}`);
const models = await mres.json();
const hasVi = m => (m.languages || []).some(l => /^vi\b|vietnam/i.test(`${l.language_id} ${l.name}`));
const modelId = ['eleven_v4', 'eleven_multilingual_v2'].find(id => models.some(m => m.model_id === id && hasVi(m)));
if (!modelId) {
  console.error('Neither eleven_v4 nor eleven_multilingual_v2 lists Vietnamese in /v1/models; aborting before any credits are spent.');
  process.exit(1);
}
console.log(`model: ${modelId}`);
fs.mkdirSync(out, { recursive: true });

// (b)-(c) per voice: generate every excerpt line
const results = [];
let billed = 0;
for (const v of voices) {
  // no GET /v1/voices/<id> pre-check: it returns 400 for library voices that still synthesise fine
  const vslug = slug(v.name);
  const files = [];
  let voiceChars = 0;
  let skipped = null;
  for (const [i, ln] of lines.entries()) {
    const hash = crypto.createHash('sha1').update(JSON.stringify([ln.text, v.id, modelId, settings])).digest('hex').slice(0, 10);
    const file = `${vslug}-${ln.id}-${ln.k}.mp3`;
    const raw = path.join(out, `${vslug}-${ln.id}-${ln.k}-${hash}.raw.mp3`);
    const meta = raw.replace(/\.raw\.mp3$/, '.json');
    if (!fs.existsSync(raw) || !fs.existsSync(meta)) {
      const res = await fetch(`${api}/v1/text-to-speech/${v.id}/with-timestamps?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        // neighbouring lines keep the intonation continuous across separate requests
        body: JSON.stringify({ text: ln.text, model_id: modelId, voice_settings: settings, previous_text: lines[i - 1]?.text, next_text: lines[i + 1]?.text }),
      });
      if (!res.ok) {
        const body = await res.text();
        // a voice that cannot synthesise (e.g. library voice not in "My voices") is skipped, not fatal
        if (voiceUnavailable(res.status, body, v.id)) {
          skipped = `cannot synthesise (HTTP ${res.status}) ${body.replace(/\s+/g, ' ').slice(0, 160)}`;
          break;
        }
        throw new Error(`${v.name} ${ln.id}#${ln.k}: HTTP ${res.status} ${body}`);
      }
      const j = await res.json();
      fs.writeFileSync(raw, Buffer.from(j.audio_base64, 'base64'));
      const ends = j.alignment.character_end_times_seconds;
      fs.writeFileSync(meta, JSON.stringify({ text: ln.text, dur: ends[ends.length - 1] }) + '\n');
      voiceChars += ln.text.length;
      console.log(`generated ${file}`);
    }
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-filter:a', `atempo=${tempo}`, '-b:a', '160k', path.join(out, file)]);
    const dur = JSON.parse(fs.readFileSync(meta, 'utf8')).dur / tempo;
    files.push({ ...ln, file, dur });
  }
  billed += voiceChars;
  if (skipped) {
    console.log(`skip ${v.name}: ${skipped}`);
    results.push({ ...v, skipped });
  } else results.push({ ...v, files, chars: voiceChars });
}

// (d) listening page
const ok = results.filter(r => r.files);
const fmt = s => `${s.toFixed(1)} s`;
const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Giọng đọc thử</title>
<style>
:root { color-scheme: light dark; --bg: #faf8f5; --fg: #1d1b19; --muted: #6b665f; --card: #fff; --line: #e3ded6; }
@media (prefers-color-scheme: dark) { :root { --bg: #151413; --fg: #efece6; --muted: #a09a90; --card: #201e1c; --line: #34312d; } }
body { margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 52rem; margin: 0 auto; }
h1 { margin: 0 0 .25rem; }
p.meta, .muted { color: var(--muted); font-size: .9rem; }
section { background: var(--card); border: 1px solid var(--line); border-radius: .75rem; padding: 1rem 1.25rem; margin: 1.25rem 0; }
blockquote { margin: .25rem 0 1rem; font-size: 1.05rem; }
.row { display: flex; align-items: center; gap: 1rem; padding: .35rem 0; border-top: 1px solid var(--line); }
.row b { flex: 0 0 11rem; }
audio { flex: 1; min-width: 0; }
table { border-collapse: collapse; width: 100%; }
td, th { text-align: left; padding: .3rem .5rem; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<main>
<h1>Giọng đọc thử</h1>
<p class="meta">Model ${esc(modelId)}, tempo ${tempo}, stability ${settings.stability}, style ${settings.style}. Cùng một đoạn, ${ok.length} giọng.</p>
<section>
<table>
<tr><th>Giọng</th><th>Tổng thời lượng</th><th>Ký tự tính phí (lần chạy này)</th></tr>
${ok.map(r => `<tr><td>${esc(r.name)}</td><td>${fmt(r.files.reduce((n, f) => n + f.dur, 0))}</td><td>${r.chars}</td></tr>`).join('\n')}
</table>
${results.filter(r => r.skipped).map(r => `<p class="muted">Bỏ qua ${esc(r.name)}: ${esc(r.skipped)}</p>`).join('\n')}
</section>
${lines.map((ln, i) => `<section>
<p class="muted">${esc(ln.id)} #${ln.k}</p>
<blockquote>${esc(ln.text)}</blockquote>
${ok.map(r => `<div class="row"><b>${esc(r.name)}</b><audio controls preload="none" src="${esc(r.files[i].file)}"></audio></div>`).join('\n')}
</section>`).join('\n')}
</main>
</body>
</html>
`;
fs.writeFileSync(path.join(out, 'index.html'), html);
if (!ok.length) {
  console.error('No voice generated; every candidate was skipped.');
  process.exit(1);
}

// summary
for (const r of ok) console.log(`${r.name}: ${fmt(r.files.reduce((n, f) => n + f.dur, 0))}`);
console.log(`${ok.length} voices generated, ${results.length - ok.length} skipped, ${lines.length} lines each, ${billed} characters billed this run`);
console.log(`listening page: ${path.join(out, 'index.html')}`);
