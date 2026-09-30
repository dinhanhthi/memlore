/* Shared drawing kit for the Memlore scenes: backdrop, cinematic text reveals, captions,
   the app window frame and its camera. Pure functions of their arguments; no state. */
(function () {
  const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const cubicOut = (t) => 1 - Math.pow(1 - t, 3);
  const cubicInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function rgba(hex, a) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
    if (!m) throw new Error(`BRAND color must be #RGB, #RRGGBB or #RRGGBBAA, got "${hex}"`);
    const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    const n = parseInt(h.slice(0, 6), 16);
    const k = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a * k})`;
  }

  function wrap(ctx, s, font, maxW) {
    ctx.font = font;
    const lines = [];
    let cur = "";
    for (const w of s.split(/\s+/)) {
      const next = cur ? cur + " " + w : w;
      if (cur && ctx.measureText(next).width > maxW) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* Dark stage with two slow, soft accent lights and a vignette. */
  function backdrop(ctx, env, lt, seed = 0, strength = 1) {
    const { W, H, brand } = env;
    const c = brand.colors;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    const lights = [
      [0.22 + 0.04 * Math.sin(lt * 0.21 + seed), 0.3 + 0.05 * Math.cos(lt * 0.17 + seed), c.accent, 0.1],
      [0.8 + 0.04 * Math.cos(lt * 0.13 + seed * 2), 0.78 + 0.04 * Math.sin(lt * 0.19 + seed), c.fill, 0.12],
    ];
    for (const [fx, fy, col, a] of lights) {
      const g = ctx.createRadialGradient(W * fx, H * fy, 0, W * fx, H * fy, W * 0.55);
      g.addColorStop(0, rgba(col, a * strength));
      g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  /* Cinematic reveal: fade up, rise and un-blur. p in 0..1. */
  function textIn(ctx, s, x, y, font, color, p, align = "left", spacing = 0, rise = 26) {
    if (p <= 0) return;
    const e = cubicOut(clamp(p));
    ctx.save();
    ctx.globalAlpha *= e;
    const b = 10 * (1 - e);
    if (b > 0.3) ctx.filter = `blur(${b.toFixed(1)}px)`;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.letterSpacing = spacing + "px";
    ctx.fillText(s, x, y + rise * (1 - e));
    ctx.restore();
  }

  /* Caption column: eyebrow, serif headline, wrapped sub, chips. Vertically centred on cy.
     Everything is measured, so longer copy grows the block instead of overflowing it. */
  function caption(ctx, env, lt, cap, { x, cy, w, t0 = 0.3, out = Infinity }) {
    const { fonts, brand } = env;
    const c = brand.colors;
    const fEye = `500 21px ${fonts.mono}`;
    ctx.font = `400 80px ${fonts.serif}`;
    ctx.letterSpacing = "-1.5px";
    const widest = Math.max(1, ...(cap.head || []).map((l) => ctx.measureText(l).width));
    ctx.letterSpacing = "0px";
    const headSize = widest > w ? Math.floor((80 * w) / widest) : 80;
    const fHead = `400 ${headSize}px ${fonts.serif}`;
    const fSub = `400 29px ${fonts.sans}`;
    const fChip = `500 21px ${fonts.sans}`;
    const subLines = cap.sub ? wrap(ctx, cap.sub, fSub, w) : [];
    const head = cap.head || [];
    const hl = headSize * 1.06,
      sl = 29 * 1.45;
    const chipH = cap.chips ? 44 : 0;
    ctx.font = fChip;
    const chipRows = [];
    if (cap.chips) {
      let row = [],
        rw = 0;
      for (const s of cap.chips) {
        const cw = ctx.measureText(s).width + 36;
        if (row.length && rw + cw > w) {
          chipRows.push(row);
          row = [];
          rw = 0;
        }
        row.push([s, cw]);
        rw += cw + 12;
      }
      if (row.length) chipRows.push(row);
    }
    const total =
      26 + 34 + head.length * hl + (subLines.length ? 30 + subLines.length * sl : 0) + (chipRows.length ? 34 + chipRows.length * (chipH + 12) : 0);
    let y = cy - total / 2;
    const fade = 1 - seg(lt, out, out + 0.6);
    ctx.save();
    ctx.globalAlpha = fade;
    textIn(ctx, cap.eyebrow || "", x, y + 20, fEye, c.accent, seg(lt, t0, t0 + 0.9), "left", 4);
    y += 26 + 34;
    head.forEach((line, i) => {
      textIn(ctx, line, x - 3, y + hl * 0.8, fHead, c.fg, seg(lt, t0 + 0.2 + i * 0.18, t0 + 1.3 + i * 0.18), "left", -1.5);
      y += hl;
    });
    if (subLines.length) {
      y += 30;
      subLines.forEach((line, i) => {
        textIn(ctx, line, x, y + sl * 0.75, fSub, c.mute, seg(lt, t0 + 0.7 + i * 0.1, t0 + 1.7 + i * 0.1));
        y += sl;
      });
    }
    if (chipRows.length) {
      y += 34;
      let k = 0;
      for (const row of chipRows) {
        let cx = x;
        for (const [s, cw] of row) {
          const p = cubicOut(seg(lt, t0 + 1.4 + k * 0.14, t0 + 2.2 + k * 0.14));
          if (p > 0) {
            ctx.save();
            ctx.globalAlpha *= p;
            ctx.translate(0, 14 * (1 - p));
            ctx.beginPath();
            ctx.roundRect(cx, y, cw, chipH, chipH / 2);
            ctx.fillStyle = rgba(c.accent, 0.08);
            ctx.fill();
            ctx.strokeStyle = rgba(c.accent, 0.45);
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.font = fChip;
            ctx.fillStyle = c.fg;
            ctx.textAlign = "center";
            ctx.fillText(s, cx + cw / 2, y + chipH / 2 + 7);
            ctx.restore();
          }
          cx += cw + 12;
          k++;
        }
        y += chipH + 12;
      }
    }
    ctx.restore();
  }

  /* The app window: a screenshot (1440x900 CSS px captured @2x) seen through a camera `view`
     [x, y, w] in CSS px (height follows the frame's aspect). */
  const FRAME = { x: 680, y: 190, w: 1120, h: 700, r: 18 };
  function viewRect(v, f = FRAME) {
    const w = v[2],
      h = (w * f.h) / f.w;
    return [clamp(v[0], 0, 1440 - w), clamp(v[1], 0, 900 - h), w, h];
  }
  /* camera keys [{t, v:[x,y,w]}]: eased between neighbours */
  function camera(keys, lt) {
    if (lt <= keys[0].t) return keys[0].v;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i],
        b = keys[i + 1];
      if (lt <= b.t) {
        const p = cubicInOut(seg(lt, a.t, b.t));
        return a.v.map((x, k) => lerp(x, b.v[k], p));
      }
    }
    return keys[keys.length - 1].v;
  }
  function frameShadow(ctx, f, alpha = 1) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 80;
    ctx.shadowOffsetY = 30;
    ctx.beginPath();
    ctx.roundRect(f.x, f.y, f.w, f.h, f.r);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
  }
  function frame(ctx, img, view, alpha = 1, f = FRAME) {
    const [vx, vy, vw, vh] = viewRect(view, f);
    const sx = img.naturalWidth / 1440;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    ctx.roundRect(f.x, f.y, f.w, f.h, f.r);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, vx * sx, vy * sx, vw * sx, vh * sx, f.x, f.y, f.w, f.h);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.beginPath();
    ctx.roundRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1, f.r);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
  /* CSS point -> canvas point through the current view */
  function toCanvas(view, pt, f = FRAME) {
    const [vx, vy, vw, vh] = viewRect(view, f);
    return [f.x + ((pt[0] - vx) / vw) * f.w, f.y + ((pt[1] - vy) / vh) * f.h];
  }
  function ring(ctx, env, view, r, p, f = FRAME) {
    if (p <= 0) return;
    const [x0, y0] = toCanvas(view, [r[0], r[1]], f);
    const [x1, y1] = toCanvas(view, [r[0] + r[2], r[1] + r[3]], f);
    const e = cubicOut(clamp(p));
    const pad = 10 + 16 * (1 - e);
    ctx.save();
    ctx.globalAlpha *= e;
    ctx.shadowColor = rgba(env.brand.colors.accent, 0.9);
    ctx.shadowBlur = 24;
    ctx.beginPath();
    ctx.roundRect(x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2, 14);
    ctx.strokeStyle = env.brand.colors.accent2;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  window.KIT = { TAU, clamp, lerp, seg, cubicOut, cubicInOut, rgba, wrap, backdrop, textIn, caption, FRAME, viewRect, camera, frame, frameShadow, toCanvas, ring };
})();
