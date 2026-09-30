// Review app shell: owns the clock, drives the film iframe, plays audio, auto-saves
// review.json. Exposes window.Review for the timing editor (editor.js) and comment
// pins (comments.js), which plug into #scene-strip, #scene-editor, #comments-panel
// and #overlay.
(function () {
  const FRAME = 1 / 60;
  const BEAT = Timing.BEAT, BAR = Timing.BAR;
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- state + events
  const listeners = {};
  const Review = {
    tl: null, doc: null, timing: {}, layout: null, layout0: null,
    t: 0, playing: false, loopScene: false, audioMode: 'orig',
    selectedSceneId: null, frame: null, ready: null,
    on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => listeners[ev].delete(fn); },
    emit(ev, arg) { for (const fn of listeners[ev] || []) { try { fn(arg); } catch (e) { console.error(e); } } },
  };
  window.Review = Review;

  const dur = () => Review.layout ? Review.layout.dur : 0;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function sceneAt(t) {
    const sc = Review.layout.scenes;
    let cur = sc[0];
    for (const s of sc) if (t >= s.start) cur = s; else break;
    return cur;
  }
  Review.sceneAt = sceneAt;
  Review.currentScene = () => sceneAt(Review.t);

  Review.select = id => {
    Review.selectedSceneId = id;
    Review.emit('select', id);
  };

  // ---------------------------------------------------------------- film iframe
  let filmReady = false;

  function paint() {
    if (!filmReady) return;
    // the film paints black at exactly t === DUR, so show the last frame instead
    Review.frame.render(clamp(Review.t, 0, Math.max(0, dur() - FRAME)));
  }

  function loadFilm() {
    const iframe = $('film');
    return new Promise(resolve => {
      iframe.addEventListener('load', resolve, { once: true });
      iframe.src = '/film.html';
    }).then(async () => {
      Review.frame = iframe.contentWindow;
      await Review.frame.ready;
      filmReady = true;
      $('player-loading').hidden = true;
    });
  }

  function fitPlayer() {
    const area = $('player-area'), cs = getComputedStyle(area);
    const w = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const k = Math.max(0.05, Math.min(w / 1920, h / 1080));
    const sizer = $('player-sizer');
    sizer.style.width = `${1920 * k}px`;
    sizer.style.height = `${1080 * k}px`;
    $('player').style.transform = `scale(${k})`;
    Review.scale = k;
  }

  // ---------------------------------------------------------------- audio
  let ctx = null, master = null;
  const buffers = { orig: null, preview: null };
  const bufferState = { orig: 'loading', preview: 'loading' }; // loading | ready | missing | error
  let source = null, clicks = [];
  let metro = null; // { next: beat index, cuts: Set of cut times in ms }

  function audioCtx() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    return ctx;
  }

  async function loadBuffer(key, url) {
    bufferState[key] = 'loading';
    renderAudioHint();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 404) { buffers[key] = null; bufferState[key] = 'missing'; return; }
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      buffers[key] = await audioCtx().decodeAudioData(await res.arrayBuffer());
      bufferState[key] = 'ready';
    } catch (e) {
      console.warn('audio load failed', e);
      buffers[key] = null;
      bufferState[key] = 'error';
    } finally {
      renderAudioHint();
      if (Review.playing && Review.audioMode === key) restart();
    }
  }

  Review.reloadPreview = () => loadBuffer('preview', '/review/preview.wav');

  function stopAudio() {
    if (source) { try { source.stop(); } catch {} source.disconnect(); source = null; }
    for (const o of clicks) { try { o.stop(); } catch {} }
    clicks = [];
    metro = null;
  }

  // audio for output time t, starting at ctx time `at`
  function startAudio(t, at) {
    const mode = Review.audioMode, buf = buffers[mode];
    if ((mode === 'orig' || mode === 'preview') && buf && t < buf.duration) {
      source = ctx.createBufferSource();
      source.buffer = buf;
      source.connect(master);
      source.start(at, t);
    }
    if (mode === 'metronome') {
      metro = { next: Math.ceil(t / BEAT - 1e-6), cuts: new Set(Review.layout.scenes.map(s => Math.round(s.start * 1000))) };
      scheduleClicks();
    }
  }

  function click(when, kind) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    const spec = { cut: [1760, 0.5, 'square'], bar: [1320, 0.45, 'sine'], beat: [880, 0.25, 'sine'] }[kind];
    o.type = spec[2];
    o.frequency.value = spec[0];
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(spec[1], when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + (kind === 'cut' ? 0.09 : 0.05));
    o.connect(g).connect(master);
    o.start(when);
    o.stop(when + 0.1);
    o.onended = () => { g.disconnect(); clicks = clicks.filter(x => x !== o); };
    clicks.push(o);
  }

  // lookahead scheduler: queue clicks up to 0.3 s ahead of the playhead
  function scheduleClicks() {
    if (!metro || clock.kind !== 'audio') return;
    const horizon = Math.min(dur(), Review.t + 0.3);
    for (; metro.next * BEAT <= horizon; metro.next++) {
      const bt = metro.next * BEAT;
      if (bt >= dur()) break;
      const kind = metro.cuts.has(Math.round(bt * 1000)) ? 'cut' : Math.abs(bt / BAR - Math.round(bt / BAR)) < 1e-6 ? 'bar' : 'beat';
      click(Math.max(ctx.currentTime, clock.c0 + (bt - clock.t0)), kind);
    }
  }

  function renderAudioHint() {
    const hint = $('audio-hint'), mode = Review.audioMode;
    let text = '';
    if (mode === 'orig' && Review.doc && Object.keys(Review.doc.timing || {}).length) text = 'Nhạc gốc không khớp timing mới';
    else if (mode === 'preview' && bufferState.preview === 'missing') text = 'Chưa có nhạc xem trước';
    else if ((mode === 'orig' || mode === 'preview') && bufferState[mode] === 'loading') text = 'Đang tải nhạc…';
    else if ((mode === 'orig' || mode === 'preview') && bufferState[mode] === 'error') text = 'Không tải được nhạc';
    hint.textContent = text;
    hint.hidden = !text;
    for (const b of $('audio-modes').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }

  Review.setAudioMode = mode => {
    Review.audioMode = mode;
    renderAudioHint();
    if (Review.playing) resumeAudio().then(restart); // a click is a gesture: wake a suspended context
  };

  // ---------------------------------------------------------------- clock + transport
  // t = t0 + (now() - c0); now() is AudioContext time while audio plays, else performance.now
  const clock = { kind: 'perf', t0: 0, c0: 0 };
  const perfNow = () => performance.now() / 1000;
  const clockNow = () => (clock.kind === 'audio' ? ctx.currentTime : perfNow());
  let raf = 0;

  function startClock() {
    stopAudio();
    const useAudio = Review.audioMode !== 'off' && ctx && ctx.state === 'running';
    clock.kind = useAudio ? 'audio' : 'perf';
    clock.t0 = Review.t;
    clock.c0 = clockNow();
    if (useAudio) startAudio(Review.t, clock.c0);
  }

  function restart() { if (Review.playing) startClock(); }

  async function resumeAudio() {
    if (Review.audioMode === 'off') return;
    audioCtx();
    if (ctx.state === 'running') return;
    try { await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 300))]); } catch {}
  }

  function tick() {
    raf = 0;
    if (!Review.playing) return;
    const prev = sceneAt(Review.t);
    let t = clock.t0 + (clockNow() - clock.c0);
    if (Review.loopScene && t >= prev.start + prev.outDur) return Review.seek(prev.start), schedule();
    if (t >= dur()) { Review.t = dur(); Review.pause(); return; }
    Review.t = t;
    scheduleClicks();
    paint();
    Review.emit('time', t);
    schedule();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(tick); };

  Review.play = async () => {
    if (Review.playing) return;
    if (Review.t >= dur() - 1e-6) Review.t = 0;
    Review.playing = true;
    renderPlaying();
    // prime a perf clock so a pause() during the resume wait reads the current t
    Object.assign(clock, { kind: 'perf', t0: Review.t, c0: perfNow() });
    await resumeAudio();
    if (!Review.playing) return; // paused while resuming
    startClock();
    schedule();
  };

  Review.pause = () => {
    if (!Review.playing) return;
    Review.t = clamp(clock.t0 + (clockNow() - clock.c0), 0, dur());
    Review.playing = false;
    stopAudio();
    renderPlaying();
    paint();
    Review.emit('time', Review.t);
  };

  Review.toggle = () => (Review.playing ? Review.pause() : Review.play());

  Review.seek = t => {
    Review.t = clamp(Number(t) || 0, 0, dur());
    if (Review.playing) startClock();
    paint();
    Review.emit('time', Review.t);
  };

  Review.setLoop = on => {
    Review.loopScene = !!on;
    $('loop').setAttribute('aria-pressed', String(Review.loopScene));
  };

  function renderPlaying() {
    $('app').classList.toggle('playing', Review.playing);
    $('play').setAttribute('aria-label', Review.playing ? 'Tạm dừng' : 'Phát');
  }

  const fmt = t => {
    const cs = Math.round(Math.max(0, t) * 100);
    const m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, c = cs % 100;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  };
  Review.fmt = fmt;

  function renderTime() {
    const t = Review.t, s = sceneAt(t);
    $('timecode').textContent = `${fmt(t)} / ${fmt(dur())}`;
    $('scene-id').textContent = s.id;
    const chip = $('scene-section');
    chip.textContent = s.section || '';
    chip.dataset.section = s.section || '';
    const scrub = $('scrub');
    scrub.max = String(dur());
    scrub.value = String(t);
  }

  function renderDuration() {
    const a = Review.layout0.dur, b = dur();
    const old = document.createElement('span');
    old.textContent = `${a.toFixed(1)} s → `;
    const now = document.createElement('span');
    now.className = a === b ? 'new' : 'new changed';
    now.textContent = `${b.toFixed(1)} s`;
    $('duration').replaceChildren(old, now);
  }

  // ---------------------------------------------------------------- timing
  Review.setTiming = timing => {
    // keep the playhead on the same SOURCE position of the scene it is in
    const old = Review.layout && sceneAt(Review.t);
    const src = old && old.toSource(Review.t - old.start);
    Review.doc.timing = timing || {};
    Review.timing = Review.doc.timing;
    Review.layout = Timing.layout(Review.tl, Review.timing);
    if (filmReady) Review.frame.setTiming(Review.timing);
    const nw = old && Review.layout.scenes.find(s => s.id === old.id);
    if (nw) Review.t = clamp(nw.start + nw.toOutput(src), nw.start, nw.start + Math.max(0, nw.outDur - FRAME));
    Review.t = clamp(Review.t, 0, dur());
    if (Review.playing) startClock();
    paint();
    renderDuration();
    renderAudioHint();
    Review.emit('timing', Review.timing);
    Review.emit('time', Review.t);
    Review.save();
  };

  // ---------------------------------------------------------------- auto-save
  let version = 0, savedVersion = 0, inFlight = false, saveTimer = 0, saveState = 'saved';

  function setSaveState(state, detail) {
    saveState = state;
    const pill = $('save-status');
    pill.dataset.state = state;
    pill.textContent = { saved: 'Đã lưu', saving: 'Đang lưu…', conflict: 'Xung đột – tải lại', error: 'Lỗi lưu' }[state];
    pill.disabled = state !== 'conflict';
    const banner = $('banner');
    banner.hidden = state !== 'conflict' && state !== 'error';
    banner.textContent = '';
    if (state === 'conflict') {
      banner.append('review.json đã được sửa ở nơi khác. Tải lại để lấy bản mới nhất (thay đổi chưa lưu ở tab này sẽ mất).');
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'Tải lại';
      b.onclick = () => location.reload();
      banner.append(b);
    } else if (state === 'error') banner.append(`Không lưu được: ${detail || 'lỗi không rõ'}`);
    Review.emit('save', state);
  }

  const body = () => JSON.stringify(Review.doc);

  // mark the doc changed (timing or comments) and PUT it 400 ms after the last change.
  // Emits 'doc'; listeners must not call save() from it.
  Review.save = () => {
    version++;
    Review.emit('doc', Review.doc);
    if (saveState === 'conflict') return;
    setSaveState('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  };

  async function flush() {
    saveTimer = 0;
    if (inFlight || saveState === 'conflict' || version === savedVersion) return;
    inFlight = true;
    const sent = version;
    try {
      const res = await fetch('/api/review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body() });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) return setSaveState('conflict');
      if (!res.ok) { savedVersion = sent; return setSaveState('error', (data.errors || [data.error || `HTTP ${res.status}`]).join('; ')); }
      Review.doc.rev = data.rev;
      Review.doc.updatedAt = data.updatedAt;
      savedVersion = sent;
    } catch (e) {
      return setSaveState('error', e.message);
    } finally {
      inFlight = false;
    }
    if (version !== savedVersion) flush();
    else if (!saveTimer) setSaveState('saved');
  }

  Review.flush = flush;

  window.addEventListener('beforeunload', () => {
    if (saveState === 'conflict' || inFlight || version === savedVersion) return;
    fetch('/api/review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: body(), keepalive: true });
  });

  // ---------------------------------------------------------------- keys + controls
  const TEXT_INPUT = /^(text|number|search|email|url|password|tel)$/;
  const isTyping = el => el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT'
    || (el.tagName === 'INPUT' && TEXT_INPUT.test(el.type)));

  function stepScene(dir) {
    const sc = Review.layout.scenes, cur = sceneAt(Review.t), i = sc.indexOf(cur);
    if (dir < 0) Review.seek(Review.t > cur.start + 0.05 || i === 0 ? cur.start : sc[i - 1].start);
    else Review.seek(i + 1 < sc.length ? sc[i + 1].start : dur());
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const step = e.shiftKey ? FRAME : BEAT;
    const act = {
      ' ': () => Review.toggle(),
      ArrowLeft: () => Review.seek(Review.t - step),
      ArrowRight: () => Review.seek(Review.t + step),
      '[': () => stepScene(-1),
      ']': () => stepScene(1),
      l: () => Review.setLoop(!Review.loopScene),
      L: () => Review.setLoop(!Review.loopScene),
    }[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  }

  function bindControls() {
    document.addEventListener('keydown', onKey);
    $('play').onclick = () => Review.toggle();
    $('loop').onclick = () => Review.setLoop(!Review.loopScene);
    $('scrub').addEventListener('input', e => Review.seek(Number(e.target.value)));
    $('save-status').onclick = () => { if (saveState === 'conflict') location.reload(); };
    $('audio-modes').addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (b) Review.setAudioMode(b.dataset.mode);
    });
    // buttons must not keep focus, or Space would click them as well as toggle playback
    document.addEventListener('mouseup', e => { const b = e.target.closest('button'); if (b) b.blur(); });
    new ResizeObserver(fitPlayer).observe($('player-area'));
    fitPlayer();
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    bindControls();
    const [tl, doc] = await Promise.all([
      fetch('/timeline.json', { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/review', { cache: 'no-store' }).then(r => r.json()),
    ]);
    doc.timing ||= {};
    doc.comments ||= [];
    Object.assign(Review, { tl, doc, timing: doc.timing, layout0: Timing.layout(tl, {}), layout: Timing.layout(tl, doc.timing) });
    Review.on('time', renderTime);
    Review.on('timing', renderTime);
    renderTime();
    renderDuration();
    renderAudioHint();
    loadBuffer('orig', '/soundtrack.wav');
    Review.reloadPreview();
    await loadFilm();
    Review.frame.setTiming(Review.timing);
    paint();
    Review.emit('doc', doc);
    Review.emit('timing', Review.timing);
  }

  Review.ready = boot().catch(e => { console.error(e); setSaveState('error', `Không khởi động được: ${e.message}`); throw e; });
})();
