// Background score for the free-style film, via the ElevenLabs Music API.
//
//   ELEVENLABS_API_KEY=… node docs/showcase/free-style-vi/music.mjs --i-am-sure          # generate (cached)
//   ELEVENLABS_API_KEY=… node docs/showcase/free-style-vi/music.mjs --i-am-sure --test   # one 10 s call, proves access
//   node docs/showcase/free-style-vi/music.mjs --i-am-sure --dry                         # print the request, no call
//
// music-plan.json groups scenes into chapters; each chapter becomes one composition-plan section
// whose duration is the chapter's output length in the current timeline, so the score changes on
// chapter cuts. The result is cached as music/<hash>.mp3 (hash of the request) and copied to
// music/music.mp3, so only a changed plan or timeline costs credits (older hashes are kept, so
// going back to an earlier timeline is free). Key from the environment only.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import url from 'url';
import vm from 'vm';
import config from './config.mjs';

// Safety: this script can spend ElevenLabs credits, so it refuses to run without --i-am-sure.
// The check runs before anything reads the key or touches the network.
if (!process.argv.includes('--i-am-sure')) {
  console.error('music.mjs: refusing to run. It calls the paid ElevenLabs Music API and writes cache files.\nRe-run with --i-am-sure once you really mean it.');
  process.exit(1);
}

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const out = path.join(dir, config.musicDir);
const args = process.argv.slice(2);
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const sandbox = {};
vm.runInNewContext(fs.readFileSync(path.join(dir, 'timing.js'), 'utf8'), sandbox);
const lay = sandbox.Timing.layout(read(config.timeline));
const plan = read('music-plan.json');

// chapter durations from the timeline; every scene must belong to exactly one chapter, in order
const order = plan.chapters.flatMap(ch => ch.scenes);
const ids = lay.scenes.map(s => s.id);
if (order.join() !== ids.join()) throw new Error(`music-plan.json chapters must list the timeline scenes in order:\n  plan:     ${order.join(' ')}\n  timeline: ${ids.join(' ')}`);
const sections = plan.chapters.map(ch => {
  const ms = Math.round(ch.scenes.reduce((n, id) => n + lay.scenes.find(s => s.id === id).outDur, 0) * 1000);
  if (ms < 3000 || ms > 120000) throw new Error(`chapter "${ch.name}" is ${ms} ms; sections must be 3–120 s`);
  return { section_name: ch.name, positive_local_styles: ch.positive, negative_local_styles: ch.negative, duration_ms: ms, lines: [] };
});
const body = {
  model_id: plan.model_id,
  composition_plan: { positive_global_styles: plan.positive_global_styles, negative_global_styles: plan.negative_global_styles, sections },
  respect_sections_durations: true,
};
if (args.includes('--dry')) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
const post = async (payload, file) => {
  const res = await fetch('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_192', {
    method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`music: HTTP ${res.status} ${await res.text()}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
};
fs.mkdirSync(out, { recursive: true });

if (args.includes('--test')) {
  const file = path.join(out, 'test.mp3');
  await post({ prompt: plan.positive_global_styles.join(', '), music_length_ms: 10000, force_instrumental: true }, file);
  console.log('music API ok →', file);
  process.exit(0);
}

const hash = crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 10);
const cached = path.join(out, `${hash}.mp3`);
if (!fs.existsSync(cached)) {
  console.log(`generating ${sections.length} sections, ${(lay.dur).toFixed(1)} s …`);
  const tmp = cached + '.part';
  await post(body, tmp);
  // only a take of the right length is cached; a bad one is kept aside for listening
  const got = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tmp]).toString());
  if (Math.abs(got - lay.dur) > 0.5) throw new Error(`music came back ${got.toFixed(2)} s for a ${lay.dur} s film; kept as ${path.relative(dir, tmp)}`);
  fs.renameSync(tmp, cached);
}
fs.copyFileSync(cached, path.join(out, 'music.mp3'));
// sidecar: mix.mjs compares these durations with the current timeline before using music.mp3
const planSha = crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'music-plan.json'))).digest('hex');
fs.writeFileSync(path.join(out, 'music.json'), JSON.stringify({ hash, planSha, sections: sections.map(s => ({ name: s.section_name, duration_ms: s.duration_ms })) }, null, 2) + '\n');
console.log(`music/music.mp3 ← ${hash}.mp3 (${sections.map(s => `${s.section_name} ${s.duration_ms / 1000}s`).join(', ')})`);
