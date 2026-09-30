// The single place that names the Vietnamese film's inputs and outputs. All paths are relative to
// this folder. film.js runs in the browser and cannot import this module, so it mirrors the few
// paths it needs as constants at its top: keep the two in sync.
export default {
  // READ ONLY: owned by the free-style folder, never written from here.
  narration: '../free-style/narration.vi.json',
  // The voice comes from here; the `voice` block of narration.vi.json is ignored.
  voice: {
    name: 'Quang Toan',
    voice_id: 'ZsjEJaLQy3sgvwxicmDx',
    model_id: 'eleven_v4',
    tempo: 1.12,
    language_code: 'vi',
    // the audition's stability 0.15 (../free-style/audition.mjs) gave raspy takes and drifted from the
    // Southern accent into a Northern one between lines; eleven_v4 ignores `style`
    settings: { stability: 0.75, similarity_boost: 0.75, use_speaker_boost: true, speed: 1.12 },
  },
  voiceDir: 'voice-vi', // mp3 cache, manifest.json, at.json (fit.mjs output: { "<sceneId>": number | number[] })
  timeline: 'timeline.json', // this fork's own copy
  texts: 'texts.vi.json',
  audio: 'audio.wav',
  musicDir: 'music',
  film: '../free-style-showcase.vi.mp4',
  shots: '../assets/shots/free-style-vi/',
};
