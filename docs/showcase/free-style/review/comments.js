// Comment pins + sidebar. Comments are pinned in SOURCE time { sceneId, sourceT, x, y }
// on the 1920x1080 frame, so retiming a scene moves the pin with its animation frame.
// Pins live in #overlay (inside the scaled #player, so they are counter-scaled), the
// list lives in #comments-panel. User text is only ever set via textContent.
(function () {
  const R = window.Review;
  const $ = id => document.getElementById(id);
  const WINDOW = 0.5; // pins show within +-0.5 s of output time
  const STATUS = { open: 'Mở', resolved: 'Đã xử lý', wontfix: 'Bỏ qua' };
  const FILTERS = [['all', 'Tất cả'], ['open', 'Mở'], ['resolved', 'Đã xử lý'], ['wontfix', 'Bỏ qua']];
  const PLACEHOLDER = 'Mô tả chỉnh sửa bạn muốn…';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const TEXT_INPUT = /^(text|number|search|email|url|password|tel)$/;
  const isTyping = el => el && (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT'
    || (el.tagName === 'INPUT' && TEXT_INPUT.test(el.type)));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(cls, text, onclick) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  }

  // ---------------------------------------------------------------- state
  let mode = false;          // comment mode on
  let draft = null;          // { sceneId, sourceT, x, y, text } while the popover is open
  let selectedId = null;     // comment selected in the sidebar
  let filter = 'all';
  let editing = null;        // { id, text } inline edit in the sidebar
  let confirmDel = null, confirmTimer = 0;
  let overlay, pinLayer, panel, list, pins = [];

  const sceneById = id => R.layout.scenes.find(s => s.id === id);

  // all comments with an existing scene, sorted by output time; index + 1 = pin number
  function sorted() {
    const out = [];
    for (const c of R.doc.comments) {
      const s = sceneById(c.sceneId);
      if (s) out.push({ c, s, outT: s.start + s.toOutput(c.sourceT) });
    }
    out.sort((a, b) => a.outT - b.outT || String(a.c.createdAt).localeCompare(String(b.c.createdAt)));
    out.forEach((e, i) => { e.n = i + 1; });
    return out;
  }

  // ---------------------------------------------------------------- mode
  function setMode(on) {
    mode = !!on;
    $('app').classList.toggle('comment-mode', mode);
    $('comment-mode').setAttribute('aria-pressed', String(mode));
    if (!mode) closeDraft();
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || !R.layout) return;
    if (e.key === 'c' || e.key === 'C') setMode(!mode);
    else if (e.key === 'Escape' && (mode || draft)) setMode(false);
    else return;
    e.preventDefault();
  }

  // ---------------------------------------------------------------- draft popover
  function onOverlayClick(e) {
    if (!mode || e.target !== overlay) return;
    R.pause();
    const s = R.sceneAt(R.t);
    const text = draft ? draft.text : '';
    draft = {
      sceneId: s.id,
      sourceT: Math.round(s.toSource(R.t - s.start) * 1000) / 1000,
      x: clamp(Math.round(e.offsetX), 0, 1920),
      y: clamp(Math.round(e.offsetY), 0, 1080),
      text,
    };
    renderPins();
  }

  function closeDraft() {
    if (!draft) return;
    draft = null;
    renderPins();
  }

  function saveDraft() {
    const text = draft.text.trim();
    if (!text) return;
    const c = {
      id: 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
      sceneId: draft.sceneId, sourceT: draft.sourceT, x: draft.x, y: draft.y,
      text: text.slice(0, 5000), status: 'open', reply: null,
      createdAt: new Date().toISOString(), resolvedAt: null,
    };
    R.doc.comments.push(c);
    draft = null;
    selectedId = c.id;
    setMode(false);
    R.save(); // emits 'doc' -> pins + sidebar rerender
    scrollToSelected();
  }

  function buildPopover() {
    const inv = 1 / (R.scale || 1);
    const pop = el('div', 'cm-pop');
    const flipX = draft.x > 1920 - 320 * inv, flipY = draft.y > 1080 - 170 * inv;
    pop.style.left = `${draft.x + (flipX ? -18 : 18) * inv}px`;
    pop.style.top = `${draft.y + (flipY ? 12 : -12) * inv}px`;
    pop.style.transform = `scale(${inv}) translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`;
    const ta = el('textarea', 'cm-ta');
    ta.placeholder = PLACEHOLDER;
    ta.rows = 4;
    ta.maxLength = 5000;
    ta.value = draft.text;
    const save = button('ed-btn primary', 'Lưu', saveDraft);
    const sync = () => { draft.text = ta.value; save.disabled = !ta.value.trim(); };
    sync();
    ta.addEventListener('input', sync);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveDraft(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeDraft(); }
    });
    const row = el('div', 'cm-pop-row');
    row.append(el('span', 'ed-hint', '⌘/Ctrl+Enter · Esc'), el('span', 'spacer'), button('ed-btn', 'Huỷ', closeDraft), save);
    pop.append(ta, row);
    pop.addEventListener('mousedown', e => e.stopPropagation());
    return pop;
  }

  // ---------------------------------------------------------------- pins
  function renderPins() {
    if (!pinLayer || !R.layout) return;
    pins = sorted().map(({ c, outT, n }) => {
      const p = el('button', `pin s-${c.status}`, String(n));
      p.type = 'button';
      p.dataset.id = c.id;
      p.style.left = `${c.x}px`;
      p.style.top = `${c.y}px`;
      p.onclick = e => { e.stopPropagation(); if (!mode) selectComment(c.id, true); };
      return { p, outT, id: c.id };
    });
    const nodes = pins.map(x => x.p);
    if (draft) {
      const d = el('div', 'pin draft', '+');
      d.style.left = `${draft.x}px`;
      d.style.top = `${draft.y}px`;
      nodes.push(d, buildPopover());
    }
    pinLayer.replaceChildren(...nodes);
    const ta = draft && pinLayer.querySelector('.cm-pop textarea');
    if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    updatePins();
  }

  // cheap per-frame pass: visibility + selection only
  function updatePins() {
    for (const { p, outT, id } of pins) {
      p.hidden = Math.abs(outT - R.t) > WINDOW;
      p.classList.toggle('selected', id === selectedId);
    }
  }

  function updateScale() {
    if (overlay) overlay.style.setProperty('--inv', String(1 / (R.scale || 1)));
    if (draft) renderPins(); // the popover offsets depend on the scale
  }

  // ---------------------------------------------------------------- sidebar
  function selectComment(id, scroll) {
    selectedId = id;
    renderList();
    updatePins();
    if (scroll) scrollToSelected();
  }

  function scrollToSelected() {
    const n = list && list.querySelector('.cm-item.selected');
    if (n) n.scrollIntoView({ block: 'nearest' });
  }

  function setStatus(c, status) {
    c.status = status;
    c.resolvedAt = status === 'open' ? null : new Date().toISOString();
    R.save();
  }

  function onDelete(c) {
    if (confirmDel !== c.id) {
      confirmDel = c.id;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => { confirmDel = null; renderList(); }, 3000);
      return renderList();
    }
    clearTimeout(confirmTimer);
    confirmDel = null;
    R.doc.comments = R.doc.comments.filter(x => x !== c);
    if (selectedId === c.id) selectedId = null;
    R.save();
  }

  function saveEdit(c) {
    const text = editing.text.trim();
    if (!text) return;
    c.text = text.slice(0, 5000);
    editing = null;
    R.save();
  }

  function buildHead(all) {
    const head = el('div', 'cm-head');
    const open = all.filter(e => e.c.status === 'open').length;
    head.append(el('h2', 'cm-title', 'Bình luận'), el('span', 'chip', `${all.length}`));
    if (open) head.append(el('span', 'chip open', `${open} mở`));
    const pills = el('div', 'segmented cm-filter');
    pills.setAttribute('role', 'group');
    pills.setAttribute('aria-label', 'Lọc bình luận');
    for (const [key, label] of FILTERS) {
      const count = key === 'all' ? all.length : all.filter(e => e.c.status === key).length;
      const b = button('', `${label} ${count}`, () => { filter = key; renderList(); });
      b.setAttribute('aria-pressed', String(filter === key));
      pills.append(b);
    }
    return [head, pills];
  }

  function buildItem({ c, s, outT, n }) {
    const item = el('div', `cm-item s-${c.status}`);
    item.classList.toggle('selected', c.id === selectedId);
    item.dataset.id = c.id;
    item.onclick = e => {
      if (e.target.closest('select, button, textarea')) return;
      if (R.selectedSceneId !== s.id) R.select(s.id);
      R.seek(outT);
      selectComment(c.id, false);
    };

    const top = el('div', 'cm-top');
    top.append(el('span', `cm-num s-${c.status}`, String(n)), el('span', 'cm-time mono', R.fmt(outT)), el('span', 'cm-scene mono', s.id));
    const sel = el('select', 'cm-status');
    sel.setAttribute('aria-label', 'Trạng thái');
    for (const [v, label] of Object.entries(STATUS)) {
      const o = el('option', null, label);
      o.value = v;
      sel.append(o);
    }
    sel.value = c.status;
    sel.onchange = () => setStatus(c, sel.value);
    top.append(el('span', 'spacer'), sel);
    item.append(top);

    if (editing && editing.id === c.id) {
      const ta = el('textarea', 'cm-ta');
      ta.rows = 4;
      ta.maxLength = 5000;
      ta.value = editing.text;
      ta.placeholder = PLACEHOLDER;
      const save = button('ed-btn primary', 'Lưu', () => saveEdit(c));
      const sync = () => { editing.text = ta.value; save.disabled = !ta.value.trim(); };
      sync();
      ta.addEventListener('input', sync);
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(c); }
        else if (e.key === 'Escape') { e.preventDefault(); editing = null; renderList(); }
      });
      const row = el('div', 'cm-actions');
      row.append(el('span', 'spacer'), button('ed-btn', 'Huỷ', () => { editing = null; renderList(); }), save);
      item.append(ta, row);
    } else {
      item.append(el('div', 'cm-text', c.text));
      if (c.reply != null) {
        const rep = el('div', 'cm-reply');
        rep.append(el('span', 'cm-reply-label', 'Claude:'), el('div', 'cm-reply-text', c.reply));
        item.append(rep);
      }
      const row = el('div', 'cm-actions');
      const del = button(`ed-btn danger${confirmDel === c.id ? ' confirm' : ''}`, confirmDel === c.id ? 'Chắc chắn?' : 'Xoá', () => onDelete(c));
      row.append(el('span', 'spacer'), button('ed-btn', 'Sửa', () => { editing = { id: c.id, text: c.text }; renderList(); }), del);
      item.append(row);
    }
    return item;
  }

  function renderList() {
    if (!panel || !R.layout) return;
    const all = sorted();
    const shown = all.filter(e => filter === 'all' || e.c.status === filter);
    list = el('div', 'cm-list');
    if (!all.length) list.append(el('p', 'cm-empty', 'Chưa có bình luận. Nhấn C rồi bấm vào khung hình để thêm.'));
    else if (!shown.length) list.append(el('p', 'cm-empty', 'Không có bình luận nào ở bộ lọc này.'));
    for (const s of R.layout.scenes) {
      const group = shown.filter(e => e.s === s);
      if (!group.length) continue;
      const g = el('div', 'cm-group');
      const gh = el('div', 'cm-group-head');
      const chip = el('span', 'chip section', s.section || '');
      chip.dataset.section = s.section || '';
      gh.append(el('span', 'mono', s.id), chip);
      g.append(gh, ...group.map(buildItem));
      list.append(g);
    }
    panel.replaceChildren(...buildHead(all), list);
    const ta = editing && list.querySelector('.cm-item .cm-ta');
    if (ta && document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  // ---------------------------------------------------------------- wiring
  R.ready.then(() => {
    overlay = $('overlay');
    panel = $('comments-panel');
    pinLayer = el('div', 'pin-layer');
    overlay.append(pinLayer);
    overlay.addEventListener('click', onOverlayClick);
    $('comment-mode').onclick = () => setMode(!mode);
    document.addEventListener('keydown', onKey);
    new ResizeObserver(updateScale).observe($('player-sizer'));
    updateScale();
    const all = () => { renderPins(); renderList(); };
    R.on('doc', all);
    R.on('timing', all);
    R.on('time', updatePins);
    all();
  }).catch(() => {});
})();
