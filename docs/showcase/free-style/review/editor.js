// Timing editor: scene strip in output time (#scene-strip) and a per-scene panel
// (#scene-editor) with base speed, snap, beat fitting and warp ranges drawn on a
// source-time ruler. Every valid change goes through Review.setTiming(fullMap);
// a preview soundtrack is regenerated 1.5 s after the last change.
(function () {
  const R = window.Review;
  const BEAT = Timing.BEAT, BAR = Timing.BAR, SMIN = Timing.SPEED_MIN, SMAX = Timing.SPEED_MAX;
  const MIN_RANGE = 0.1, DRAG_GRID = 0.05, NEW_RANGE_SPEED = 0.5, MUSIC_DELAY = 1500;
  const $ = id => document.getElementById(id);
  const r3 = v => Math.round(v * 1000) / 1000;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmtX = v => `${+Number(v).toFixed(2)}×`;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (text, cls) => { const b = el('button', cls || 'ed-btn', text); b.type = 'button'; return b; };
  const TEXT_INPUT = /^(text|number|search|email|url|password|tel)$/;
  const isTyping = n => n && (n.tagName === 'TEXTAREA' || n.isContentEditable || n.tagName === 'SELECT'
    || (n.tagName === 'INPUT' && TEXT_INPUT.test(n.type)));

  // ---------------------------------------------------------------- timing model
  const bpm = () => R.tl.bpm || 120;
  const baseScene = id => R.tl.scenes.find(s => s.id === id);
  const layoutScene = id => R.layout.scenes.find(s => s.id === id);

  // Two shapes: an OVERRIDE (R.timing[id]; a present key replaces the timeline scene's,
  // null removes it, absent keeps it, as Timing.layout applies it) and an ENTRY (the
  // scene's effective timing keys, what the panel edits; an absent key means the default).
  const KEYS = ['beats', 'speed', 'warp', 'snap'];
  const copy = v => JSON.parse(JSON.stringify(v));

  // invalid edits live here (unsaved) so their errors can be shown inline
  let draft = null; // { id, entry, errors }

  // timeline scene with an override applied
  function merged(id, ov = R.timing[id]) {
    const s = { ...baseScene(id) };
    for (const k of KEYS) if (ov && k in ov) { if (ov[k] === null) delete s[k]; else s[k] = ov[k]; }
    return s;
  }

  // timeline scene with an entry's timing in place of its own
  function withEntry(id, entry) {
    const s = { ...baseScene(id) };
    for (const k of KEYS) { delete s[k]; if (entry[k] != null) s[k] = entry[k]; }
    return s;
  }

  const entryOfScene = s => {
    const e = {};
    for (const k of KEYS) if (s[k] != null) e[k] = copy(s[k]);
    return e;
  };
  const entryOf = id => (draft && draft.id === id ? copy(draft.entry) : entryOfScene(merged(id)));

  // entry -> override against the timeline scene: omit what matches it, null where the
  // chosen value is the default but the scene's is not; numbers rounded to 3 decimals
  function clean(id, entry) {
    const base = baseScene(id), out = {};
    const rw = w => (w || []).map(r => ({ from: r3(r.from), to: r3(r.to), speed: r3(r.speed) }));
    const put = (k, chosen, was, isDefault) => {
      if (JSON.stringify(chosen) !== JSON.stringify(was)) out[k] = isDefault ? null : chosen;
    };
    const speed = entry.speed != null ? r3(entry.speed) : 1;
    put('speed', speed, base.speed ?? 1, speed === 1);
    put('beats', entry.beats ?? null, base.beats ?? null, entry.beats == null);
    const warp = rw(entry.warp);
    put('warp', warp, rw(base.warp), !warp.length);
    const snap = entry.snap === 'bar' ? 'bar' : 'beat';
    put('snap', snap, base.snap === 'bar' ? 'bar' : 'beat', snap === 'beat');
    return out;
  }

  function commit(id, entry) {
    const e = clean(id, entry);
    const errors = Timing.validate(merged(id, e), bpm());
    if (errors.length) {
      draft = { id, entry: entryOfScene(merged(id, e)), errors };
      renderPanel();
      return false;
    }
    draft = null;
    const map = JSON.parse(JSON.stringify(R.timing));
    if (Object.keys(e).length) map[id] = e; else delete map[id];
    R.setTiming(map);
    scheduleMusic();
    return true;
  }

  // back to the timeline scene: drop the override entirely
  function resetScene(id) {
    draft = null;
    const map = JSON.parse(JSON.stringify(R.timing));
    delete map[id];
    R.setTiming(map);
    scheduleMusic();
  }

  // ---------------------------------------------------------------- preview music
  let musicTimer = 0, musicSeq = 0;
  let music = { state: 'idle', text: '' }; // idle | waiting | ready | error

  function scheduleMusic() {
    clearTimeout(musicTimer);
    music = { state: 'waiting', text: 'Đang tạo nhạc…' };
    renderMusic();
    musicTimer = setTimeout(postMusic, MUSIC_DELAY);
  }

  async function postMusic() {
    const seq = ++musicSeq;
    try {
      const res = await fetch('/api/soundtrack', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timing: R.timing }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) return; // superseded by a newer request
      if (seq !== musicSeq) return;
      if (!res.ok) {
        music = { state: 'error', text: `Lỗi tạo nhạc: ${(data.errors || [data.error || `HTTP ${res.status}`]).join('; ')}` };
      } else {
        music = { state: 'ready', text: `Nhạc xem trước sẵn sàng (${data.dur != null ? Number(data.dur).toFixed(1) : '?'} s)` };
        R.reloadPreview();
      }
    } catch (e) {
      if (seq === musicSeq) music = { state: 'error', text: `Lỗi tạo nhạc: ${e.message}` };
    }
    renderMusic();
  }

  function renderMusic() {
    const n = document.querySelector('#scene-editor .ed-music');
    if (!n) return;
    n.dataset.state = music.state;
    let text = music.text;
    if (music.state === 'waiting' && R.audioMode === 'preview') text += ' · dùng Metronome để nghe nhịp trong lúc chờ';
    n.textContent = text;
    n.hidden = !text;
  }

  // ---------------------------------------------------------------- scene strip
  let strip = null; // { ruler, track, playhead }

  function buildStrip() {
    const root = $('scene-strip');
    const wrap = el('div', 'strip');
    strip = { ruler: el('div', 'strip-ruler'), track: el('div', 'strip-track'), playhead: el('div', 'strip-playhead') };
    wrap.append(strip.ruler, strip.track, strip.playhead);
    root.replaceChildren(wrap);
    strip.track.addEventListener('click', e => {
      const b = e.target.closest('.strip-block');
      if (!b) return;
      R.select(b.dataset.id);
      R.seek(layoutScene(b.dataset.id).start);
    });
  }

  function renderRuler() {
    const dur = R.layout.dur, frag = document.createDocumentFragment();
    for (let i = 0; i * BEAT <= dur + 1e-6; i++) {
      const t = i * BEAT, bar = Math.abs(t / BAR - Math.round(t / BAR)) < 1e-6;
      const tick = el('div', bar ? 'tick bar' : 'tick');
      tick.style.left = `${(t / dur) * 100}%`;
      frag.append(tick);
    }
    for (let s = 0; s <= dur - 3; s += 10) { // no label hanging off the right edge
      const lab = el('div', 'tick-label mono', `${s}`);
      lab.style.left = `${(s / dur) * 100}%`;
      frag.append(lab);
    }
    strip.ruler.replaceChildren(frag);
  }

  function renderBlocks() {
    const dur = R.layout.dur, counts = {};
    for (const c of R.doc.comments || []) counts[c.sceneId] = (counts[c.sceneId] || 0) + 1;
    const frag = document.createDocumentFragment();
    for (const s of R.layout.scenes) {
      const sc = merged(s.id), speed = sc.speed ?? 1, n = (sc.warp || []).length;
      const b = el('div', 'strip-block');
      b.dataset.id = s.id;
      b.dataset.section = s.section || '';
      b.classList.toggle('selected', s.id === R.selectedSceneId);
      b.style.left = `${(s.start / dur) * 100}%`;
      b.style.width = `${(s.outDur / dur) * 100}%`;
      b.setAttribute('aria-label', `${s.id}, ${Math.round(s.outDur / BEAT)} nhịp`);
      b.append(el('span', 'sb-id', s.id), el('span', 'sb-beats', `${Math.round(s.outDur / BEAT)} nhịp`));
      if (speed !== 1 || n) b.append(el('span', 'sb-badge', n ? `${fmtX(speed)} · ${n} đoạn` : fmtX(speed)));
      if (counts[s.id]) b.append(el('span', 'sb-comments', `${counts[s.id]}`));
      frag.append(b);
    }
    strip.track.replaceChildren(frag);
  }

  function renderPlayhead() {
    if (strip) strip.playhead.style.left = `${(R.t / R.layout.dur) * 100}%`;
  }

  // ---------------------------------------------------------------- scene panel
  let panel = null; // DOM refs for the selected scene
  let selRange = -1, pendingIn = null, drag = null;

  function buildPanel() {
    const id = R.selectedSceneId, root = $('scene-editor');
    if (!id) { root.replaceChildren(); panel = null; return; }
    const p = { id };
    const wrap = el('div', 'ed');

    const head = el('div', 'ed-head');
    p.section = el('span', 'chip section');
    p.readout = el('span', 'ed-readout mono');
    p.music = el('span', 'ed-music');
    head.append(el('span', 'scene-id', id), p.section, p.readout, el('span', 'spacer'), p.music);

    const row = el('div', 'ed-row');
    p.slider = el('input', 'ed-slider');
    Object.assign(p.slider, { type: 'range', min: String(Math.log2(SMIN)), max: String(Math.log2(SMAX)), step: '0.01' });
    p.slider.setAttribute('aria-label', 'Tốc độ');
    p.num = el('input', 'ed-num mono');
    Object.assign(p.num, { type: 'number', min: String(SMIN), max: String(SMAX), step: '0.05' });
    p.num.setAttribute('aria-label', 'Tốc độ');
    p.snap = el('div', 'segmented ed-snap');
    p.snap.setAttribute('role', 'group');
    p.snap.setAttribute('aria-label', 'Làm tròn');
    for (const [k, label] of [['beat', 'Nhịp'], ['bar', 'Ô nhịp']]) { const b = button(label, ''); b.dataset.snap = k; p.snap.append(b); }
    p.round = button('Khớp nhịp');
    p.fit = button('Vừa khít');
    p.minus = button('−1 nhịp');
    p.plus = button('+1 nhịp');
    p.reset = button('Đặt lại cảnh', 'ed-btn danger');
    row.append(el('span', 'ed-label', 'Tốc độ'), p.slider, p.num, el('span', 'ed-label', 'Làm tròn'), p.snap,
      p.round, p.fit, p.minus, p.plus, el('span', 'spacer'), p.reset);

    const src = el('div', 'src');
    p.srcLabel = el('div', 'src-label');
    p.ruler = el('div', 'src-ruler');
    p.ctl = el('div', 'src-ctl');
    src.append(p.srcLabel, p.ruler, p.ctl);

    p.errors = el('div', 'ed-errors');
    wrap.append(head, row, src, p.errors);
    root.replaceChildren(wrap);
    panel = p;
    bindPanel(p);
    renderPanel();
    renderMusic();
  }

  const sliderToSpeed = x => clamp(Math.round(2 ** x / 0.05) * 0.05, SMIN, SMAX);

  function bindPanel(p) {
    const edit = fn => { const e = entryOf(p.id); fn(e); commit(p.id, e); };
    p.slider.addEventListener('input', () => edit(e => { e.speed = sliderToSpeed(Number(p.slider.value)); }));
    p.slider.addEventListener('keydown', e => e.stopPropagation()); // arrows move the slider, not the playhead
    p.num.addEventListener('change', () => edit(e => { e.speed = Number(p.num.value); }));
    p.snap.addEventListener('click', ev => {
      const b = ev.target.closest('button[data-snap]');
      // explicit beats override snapping, so choosing a snap drops them
      if (b) edit(e => { e.snap = b.dataset.snap; delete e.beats; });
    });
    p.round.onclick = () => edit(e => { delete e.beats; });
    p.fit.onclick = () => {
      const e = entryOf(p.id), v = Timing.fitSpeed(withEntry(p.id, e), Math.round(layoutScene(p.id).outDur / BEAT), bpm());
      if (v == null) return;
      e.speed = v;
      commit(p.id, e);
    };
    const step = d => edit(e => { e.beats = Math.max(1, Math.round(layoutScene(p.id).outDur / BEAT) + d); });
    p.minus.onclick = () => step(-1);
    p.plus.onclick = () => step(1);
    p.reset.onclick = () => { draft = null; selRange = -1; pendingIn = null; resetScene(p.id); };
    p.ruler.addEventListener('pointerdown', onRulerDown);
    p.ruler.addEventListener('pointermove', onRulerMove);
    p.ruler.addEventListener('pointerup', onRulerUp);
    p.ruler.addEventListener('pointercancel', onRulerUp);
  }

  function renderPanel() {
    const p = panel;
    if (!p || !R.layout) return;
    const id = p.id, entry = entryOf(id), sc = withEntry(id, entry), lay = layoutScene(id);
    const m = Timing.sceneMap(sc, bpm()), speed = sc.speed ?? 1;
    // a draft may be invalid, so fall back to the saved layout for output numbers
    const outDur = draft && draft.id === id ? lay.outDur : m.outDur;
    const beats = Math.round(outDur / BEAT);
    const covered = Math.min(m.srcDur, m.toSource(outDur));
    const cut = covered < m.srcDur - 0.01, over = outDur > m.rawOutDur + 0.01;

    p.section.textContent = sc.section || '';
    p.section.dataset.section = sc.section || '';
    p.readout.textContent = `raw ${m.rawOutDur.toFixed(2)} s → ${beats} nhịp (${outDur.toFixed(2)} s) · phủ ${covered.toFixed(2)} / ${m.srcDur.toFixed(2)} s nguồn`
      + (cut ? ' · bị cắt' : over ? ' · dư' : '');
    p.readout.classList.toggle('warn', cut || over);

    if (document.activeElement !== p.slider) p.slider.value = String(Math.log2(clamp(speed, SMIN, SMAX)));
    if (document.activeElement !== p.num) p.num.value = String(r3(speed));
    for (const b of p.snap.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.snap === (sc.snap || 'beat')));
    p.round.disabled = entry.beats == null;
    const fit = Timing.fitSpeed(sc, beats, bpm());
    p.fit.disabled = fit == null || Math.abs(m.rawOutDur - outDur) < 0.001;
    p.minus.disabled = beats <= 1;
    p.reset.disabled = !Object.keys(R.timing[id] || {}).length && !(draft && draft.id === id);

    const errs = draft && draft.id === id ? draft.errors : [];
    p.errors.replaceChildren(...errs.map(e => el('div', '', e)));
    p.errors.hidden = !errs.length;

    renderSource(p, sc, m.srcDur);
    renderSourcePlayhead();
  }

  function renderSource(p, sc, srcDur) {
    const warp = sc.warp || [];
    if (selRange >= warp.length) selRange = -1;
    p.srcLabel.textContent = `Nguồn 0–${+srcDur.toFixed(2)} s · kéo để tạo đoạn, kéo mép để đổi độ dài · I / O đặt điểm vào / ra`;
    const pct = v => `${(v / srcDur) * 100}%`, frag = document.createDocumentFragment();
    for (let s = 0; s <= srcDur + 1e-6; s += BEAT) {
      const whole = Math.abs(s - Math.round(s)) < 1e-6;
      const tick = el('div', whole ? 'tick bar' : 'tick');
      tick.style.left = pct(s);
      frag.append(tick);
      if (whole && Math.round(s) % 2 === 0 && s < srcDur - 0.5) { const lab = el('div', 'tick-label mono', `${Math.round(s)}`); lab.style.left = pct(s); frag.append(lab); }
    }
    warp.forEach((r, i) => {
      const band = el('div', 'band');
      band.dataset.i = String(i);
      band.classList.toggle('selected', i === selRange);
      band.classList.toggle('slow', r.speed < 1);
      band.style.left = pct(r.from);
      band.style.width = pct(r.to - r.from);
      const hl = el('div', 'handle l'), hr = el('div', 'handle r');
      hl.dataset.edge = 'from';
      hr.dataset.edge = 'to';
      band.append(hl, el('span', 'band-label mono', fmtX(r.speed)), hr);
      frag.append(band);
    });
    if (pendingIn && pendingIn.id === p.id) {
      const pin = el('div', 'src-in');
      pin.style.left = pct(clamp(pendingIn.from, 0, srcDur));
      frag.append(pin);
    }
    p.playhead = el('div', 'src-playhead');
    frag.append(p.playhead);
    p.ruler.replaceChildren(frag);

    // inline controls for the selected range
    const r = warp[selRange];
    if (!r) { p.ctl.replaceChildren(); p.ctl.hidden = true; return; }
    p.ctl.hidden = false;
    const num = el('input', 'ed-num mono');
    Object.assign(num, { type: 'number', min: String(SMIN), max: String(SMAX), step: '0.05', value: String(r.speed) });
    num.setAttribute('aria-label', 'Tốc độ đoạn');
    num.addEventListener('change', () => editRange(e => { e.warp[selRange].speed = Number(num.value); }));
    const del = button('Xoá đoạn', 'ed-btn danger');
    del.onclick = deleteRange;
    p.ctl.replaceChildren(el('span', 'ed-label', `Đoạn ${selRange + 1}: ${r.from.toFixed(2)}–${r.to.toFixed(2)} s`),
      el('span', 'ed-label', 'Tốc độ'), num, del, el('span', 'ed-hint', 'Delete để xoá'));
  }

  function renderSourcePlayhead() {
    const p = panel;
    if (!p || !p.playhead || !R.layout) return;
    const cur = R.sceneAt(R.t), lay = layoutScene(p.id);
    const inside = cur.id === p.id;
    p.playhead.hidden = !inside;
    if (inside) p.playhead.style.left = `${(clamp(lay.toSource(R.t - lay.start), 0, lay.srcDur) / lay.srcDur) * 100}%`;
  }

  function editRange(fn) {
    const e = entryOf(panel.id);
    e.warp = (e.warp || []).map(r => ({ ...r }));
    fn(e);
    commit(panel.id, e);
  }

  function deleteRange() {
    if (!panel || selRange < 0) return;
    const i = selRange;
    selRange = -1;
    editRange(e => { e.warp.splice(i, 1); });
  }

  // ---------------------------------------------------------------- source ruler drag
  function srcAt(ev) {
    const rect = panel.ruler.getBoundingClientRect(), srcDur = layoutScene(panel.id).srcDur;
    const v = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * srcDur;
    return clamp(Math.round(v / DRAG_GRID) * DRAG_GRID, 0, srcDur);
  }

  // free space around range i (or around source time s when i is -1)
  function gap(warp, i, s, srcDur) {
    if (i >= 0) return [i > 0 ? warp[i - 1].to : 0, i + 1 < warp.length ? warp[i + 1].from : srcDur];
    let lo = 0, hi = srcDur;
    for (const r of warp) { if (r.to <= s) lo = r.to; else if (r.from >= s) { hi = r.from; break; } }
    return [lo, hi];
  }

  function onRulerDown(ev) {
    if (ev.button !== 0 || !panel) return;
    const e = entryOf(panel.id), warp = (e.warp || []).map(r => ({ ...r })), s = srcAt(ev);
    const srcDur = layoutScene(panel.id).srcDur, band = ev.target.closest('.band');
    ev.preventDefault();
    panel.ruler.setPointerCapture(ev.pointerId);
    if (band) {
      const i = Number(band.dataset.i), edge = ev.target.dataset.edge;
      selRange = i;
      drag = { mode: edge || 'move', i, s0: s, r0: { ...warp[i] }, gap: gap(warp, i, s, srcDur), warp, moved: false };
      renderPanel();
    } else {
      // an invalid draft cannot grow a new range: its gaps are not well defined
      if (draft && draft.id === panel.id) return;
      selRange = -1;
      drag = { mode: 'create', s0: s, gap: gap(warp, -1, s, srcDur), warp, moved: false };
      renderPanel();
    }
  }

  function onRulerMove(ev) {
    if (!drag || !panel) return;
    const s = srcAt(ev), [lo, hi] = drag.gap, warp = drag.warp.map(r => ({ ...r }));
    if (!drag.moved && Math.abs(s - drag.s0) < DRAG_GRID) return;
    drag.moved = true;
    if (drag.mode === 'create') {
      const from = clamp(Math.min(s, drag.s0), lo, hi), to = clamp(Math.max(s, drag.s0), lo, hi);
      if (to - from < MIN_RANGE) return;
      const at = warp.findIndex(r => r.from >= to);
      const i = at < 0 ? warp.length : at;
      warp.splice(i, 0, { from, to, speed: NEW_RANGE_SPEED });
      selRange = i;
    } else {
      const r = warp[drag.i], r0 = drag.r0, len = r0.to - r0.from;
      if (drag.mode === 'from') r.from = clamp(s, lo, r0.to - MIN_RANGE);
      else if (drag.mode === 'to') r.to = clamp(s, r0.from + MIN_RANGE, hi);
      else { r.from = clamp(r0.from + (s - drag.s0), lo, hi - len); r.to = r.from + len; }
    }
    const e = entryOf(panel.id);
    e.warp = warp;
    commit(panel.id, e);
  }

  function onRulerUp(ev) {
    if (!drag) return;
    if (panel && panel.ruler.hasPointerCapture(ev.pointerId)) panel.ruler.releasePointerCapture(ev.pointerId);
    drag = null;
    renderPanel();
  }

  // ---------------------------------------------------------------- keys
  function playheadSource() {
    const cur = R.sceneAt(R.t);
    return { id: cur.id, s: r3(clamp(cur.toSource(R.t - cur.start), 0, cur.srcDur)) };
  }

  function onKey(ev) {
    if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(ev.target) || !R.layout) return;
    const k = ev.key;
    if (k === 'i' || k === 'I') {
      const { id, s } = playheadSource();
      if (id !== R.selectedSceneId) R.select(id);
      pendingIn = { id, from: s };
      renderPanel();
    } else if (k === 'o' || k === 'O') {
      const { id, s } = playheadSource();
      if (!pendingIn || pendingIn.id !== id) return;
      const from = Math.min(pendingIn.from, s), to = Math.max(pendingIn.from, s);
      pendingIn = null;
      if (to - from < MIN_RANGE) return renderPanel();
      if (id !== R.selectedSceneId) R.select(id);
      const e = entryOf(id);
      e.warp = (e.warp || []).map(r => ({ ...r }));
      e.warp.push({ from, to, speed: NEW_RANGE_SPEED });
      e.warp.sort((a, b) => a.from - b.from); // overlaps are left for validate() to report
      selRange = e.warp.findIndex(r => r.from === from && r.to === to);
      commit(id, e);
    } else if ((k === 'Delete' || k === 'Backspace') && selRange >= 0) {
      deleteRange();
    } else return;
    ev.preventDefault();
  }

  // ---------------------------------------------------------------- wiring
  function renderStrip() {
    if (!R.layout || !strip) return;
    renderRuler();
    renderBlocks();
    renderPlayhead();
  }

  function autoSelect() {
    if (R.layout && R.selectedSceneId == null) R.select(R.sceneAt(R.t).id);
  }

  R.ready.then(() => {
    buildStrip();
    renderStrip();
    R.on('timing', () => { renderStrip(); renderPanel(); });
    R.on('doc', () => { if (strip) renderBlocks(); });
    R.on('select', () => {
      draft = null;
      selRange = -1;
      if (strip) renderBlocks();
      buildPanel();
    });
    R.on('time', () => { renderPlayhead(); renderSourcePlayhead(); autoSelect(); });
    document.addEventListener('keydown', onKey);
    $('audio-modes').addEventListener('click', () => setTimeout(renderMusic));
    autoSelect();
  }).catch(() => {});
})();
