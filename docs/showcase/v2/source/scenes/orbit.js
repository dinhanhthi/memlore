/* Scene "orbit": center badge (logo or wordmark) with integration/provider names orbiting on
   one ring (<= 6 items) or two rings, plus one trust line.
   Key = filename: TIMELINE uses { scene: "orbit" }. Load after the engine defines SCENES.
   Natural length ~3 s. opts (defaults: env.str.orbit): heading, center, items[], trust,
   logo (a loaded HTMLImageElement, optional). Only list integrations the fact sheet proves. */
(function () {
  const TAU = Math.PI * 2;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  /* BRAND colors must be #RGB, #RRGGBB or #RRGGBBAA (AA multiplies a); anything else throws. */
  function rgba(hex, a) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex);
    if (!m)
      throw new Error(
        `BRAND color must be #RGB, #RRGGBB or #RRGGBBAA, got "${hex}"`,
      );
    const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
    const n = parseInt(h.slice(0, 6), 16);
    const k = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a * k})`;
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  }
  function fit(ctx, s, font, max, maxW) {
    ctx.font = font(max);
    const w = ctx.measureText(s).width;
    return w <= maxW ? max : Math.floor((max * maxW) / w);
  }
  const loaded = (img) => Boolean(img && img.complete && img.naturalWidth > 0);

  SCENES["orbit"] = {
    draw(ctx, lt, opts, env) {
      const { W, H, ease, spring, brand, fonts } = env;
      const c = brand.colors;
      const d = env.str.orbit || {};
      const pick = (k, f) =>
        opts[k] !== undefined ? opts[k] : d[k] !== undefined ? d[k] : f;
      const heading = pick("heading", "");
      const center = pick("center", env.str.wordmark || brand.name);
      const items = pick("items", []);
      const trust = pick("trust", "");
      const logo = loaded(opts.logo) ? opts.logo : loaded(env.img && env.img.appicon) ? env.img.appicon : null;
      const u = Math.min(W, H) / 1080;

      window.KIT.backdrop(ctx, env, lt, 9);

      /* heading and trust line reserve bands at the top and bottom */
      const my = H * 0.07;
      const hf = (s) => `400 ${s}px ${fonts.serif}`;
      const hs = heading ? fit(ctx, heading, hf, 64 * u, W * 0.88) : 0;
      const trf = (s) => `500 ${s}px ${fonts.sans}`;
      const trs = trust ? fit(ctx, trust, trf, 32 * u, W * 0.88 - 60 * u) : 0;
      const topB = my + hs * 1.5;
      const botB = H - my - trs * 2.2;
      const cx = W / 2,
        cy = (topB + botB) / 2;

      /* pills: measured from their text */
      const pf = `500 ${Math.round(24 * u)}px ${fonts.sans}`;
      ctx.font = pf;
      const ph = 56 * u;
      const pws = items.map((s) => ctx.measureText(s).width + 48 * u);
      const maxPw = Math.max(0, ...pws);
      const two = items.length > 6;
      const nIn = two ? Math.ceil(items.length * 0.4) : items.length;
      const rx = Math.max(60 * u, W / 2 - W * 0.05 - maxPw / 2);
      const ry = Math.max(60 * u, (botB - topB) / 2 - ph / 2 - 8 * u);
      const rings = two
        ? [
            [rx * 0.55, ry * 0.55],
            [rx, ry],
          ]
        : [[rx * 0.8, ry * 0.8]];

      /* rings */
      rings.forEach(([a, b], k) => {
        const p = ease.expoOut(seg(lt, 0.1 + k * 0.12, 0.8 + k * 0.12));
        ctx.strokeStyle = rgba(c.fg, 0.12 * p);
        ctx.lineWidth = 2 * u;
        ctx.setLineDash([6 * u, 10 * u]);
        ctx.lineDashOffset = -lt * 30 * u * (k ? -1 : 1);
        ctx.beginPath();
        ctx.ellipse(cx, cy, a * p, b * p, 0, 0, TAU);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      /* center badge */
      const R = Math.min(rings[0][0], rings[0][1]) * (two ? 0.55 : 0.45);
      const bp = spring(lt - 0.05, { stiffness: 1.7, damping: 0.5 });
      if (bp > 0) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(bp, bp);
        const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2.2);
        glow.addColorStop(0, rgba(c.accent, 0.35));
        glow.addColorStop(1, rgba(c.accent, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(-R * 2.2, -R * 2.2, R * 4.4, R * 4.4);
        ctx.fillStyle = c.accent;
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, TAU);
        ctx.fill();
        if (logo) {
          const s = R * 1.3;
          ctx.drawImage(logo, -s / 2, -s / 2, s, s);
        } else {
          const cs = fit(
            ctx,
            center,
            (s) => `800 ${s}px ${fonts.sans}`,
            R * 0.5,
            R * 1.6,
          );
          ctx.font = `800 ${cs}px ${fonts.sans}`;
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(center, 0, 0);
          ctx.textBaseline = "alphabetic";
        }
        ctx.restore();
      }

      /* orbiting pills: angle is a pure function of lt; outer ring turns the other way */
      items.forEach((name, i) => {
        const ring = two && i >= nIn ? 1 : 0;
        const idx = ring ? i - nIn : i;
        const count = ring ? items.length - nIn : nIn;
        const [a, b] = rings[ring];
        const ang =
          (idx / count) * TAU + (ring ? 0.4 : 0) + lt * (ring ? -0.07 : 0.09);
        const p = spring(lt - 0.3 - i * 0.06, {
          stiffness: 1.8,
          damping: 0.55,
        });
        if (p <= 0) return;
        const x = cx + Math.cos(ang) * a * Math.min(1, p),
          y = cy + Math.sin(ang) * b * Math.min(1, p);
        const w = pws[i];
        ctx.save();
        ctx.globalAlpha = clamp(p * 2);
        ctx.translate(x, y);
        ctx.scale(p, p);
        rr(ctx, -w / 2, -ph / 2, w, ph, ph / 2);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.strokeStyle = rgba(ring ? c.accent2 : c.accent, 0.6);
        ctx.lineWidth = 2 * u;
        ctx.stroke();
        ctx.font = pf;
        ctx.fillStyle = c.fg;
        ctx.textAlign = "center";
        ctx.fillText(name, 0, 9 * u);
        ctx.restore();
      });

      if (heading) {
        const p = ease.expoOut(seg(lt, 0.05, 0.6));
        ctx.globalAlpha = p;
        ctx.font = hf(hs);
        ctx.fillStyle = c.fg;
        ctx.textAlign = "center";
        ctx.fillText(heading, W / 2, my + hs + 24 * u * (1 - p));
        ctx.globalAlpha = 1;
      }
      if (trust) {
        const p = ease.expoOut(seg(lt, 1.1, 1.7));
        ctx.globalAlpha = p;
        ctx.font = trf(trs);
        const tw = ctx.measureText(trust).width;
        const x0 = W / 2 - (tw + 50 * u) / 2;
        const y = H - my - trs * 0.4;
        ctx.strokeStyle = c.accent2;
        ctx.lineWidth = 4 * u;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(x0, y - trs * 0.35);
        ctx.lineTo(x0 + 10 * u, y - trs * 0.35 + 10 * u);
        ctx.lineTo(x0 + 30 * u, y - trs * 0.35 - 12 * u);
        ctx.stroke();
        ctx.fillStyle = c.fg;
        ctx.textAlign = "left";
        ctx.fillText(trust, x0 + 50 * u, y);
        ctx.globalAlpha = 1;
      }
    },
  };
})();
