/* Scene "atlas": a stylised Locations map (Natural Earth 110m land, docs/showcase/assets/land.js) in the app
   window. The demo ships no map tiles, so the map is drawn, not captured. Pins are the demo
   journal's real ones (web/fixtures/media.ts:533-575); the Lisbon pin carries its gallery photo. */
(function () {
  const K = window.KIT;
  let LAND = null; // Path2D built once from constant data: not frame state
  const PINS = [
    { lat: 38.7139, lon: -9.1334, label: "Alfama, Lisbon", photo: [485, 460, 288, 190] },
    { lat: 38.7978, lon: -9.3875, label: "Sintra, Portugal" },
    { lat: 41.1413, lon: -8.6148, label: "Ribeira, Porto" },
  ];
  SCENES["atlas"] = {
    draw(ctx, lt, opts, env) {
      const { brand, fonts } = env;
      const c = brand.colors;
      const F = K.FRAME;
      if (!LAND) LAND = new Path2D(window.LAND_D);
      K.backdrop(ctx, env, lt + 6, 4);
      K.frameShadow(ctx, F);

      /* camera: centre (lon, lat) and px per degree, Iberia -> Portugal */
      const z = K.cubicInOut(K.seg(lt, 0.2, 4.2));
      const lon0 = K.lerp(-4, -7.2, z),
        lat0 = K.lerp(40.2, 40.0, z);
      const k = K.lerp(55, 105, z);
      const cosl = Math.cos((lat0 * Math.PI) / 180);
      const px = (lon, lat) => [F.x + F.w / 2 + (lon - lon0) * k * cosl, F.y + F.h / 2 - (lat - lat0) * k];

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(F.x, F.y, F.w, F.h, F.r);
      ctx.clip();
      ctx.fillStyle = "#141414";
      ctx.fillRect(F.x, F.y, F.w, F.h);
      /* graticule */
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      for (let lo = -20; lo <= 10; lo += 2) {
        const [x] = px(lo, 0);
        ctx.beginPath();
        ctx.moveTo(x, F.y);
        ctx.lineTo(x, F.y + F.h);
        ctx.stroke();
      }
      for (let la = 30; la <= 50; la += 2) {
        const [, y] = px(0, la);
        ctx.beginPath();
        ctx.moveTo(F.x, y);
        ctx.lineTo(F.x + F.w, y);
        ctx.stroke();
      }
      /* land: path is in (lon + 180, 90 - lat) space */
      ctx.save();
      const [ox, oy] = px(-180, 90);
      ctx.translate(ox, oy);
      ctx.scale(k * cosl, k);
      ctx.fillStyle = "#242424";
      ctx.fill(LAND);
      ctx.lineWidth = 1.2 / k;
      ctx.strokeStyle = "#3a3a3a";
      ctx.stroke(LAND);
      ctx.restore();

      /* pins */
      PINS.forEach((p, i) => {
        const pp = K.cubicOut(K.seg(lt, 1.2 + i * 0.4, 2.0 + i * 0.4));
        if (pp <= 0) return;
        const [x, y] = px(p.lon, p.lat);
        const pulse = K.seg((lt - 1.2 - i * 0.4) % 2.2, 0, 2.2);
        ctx.strokeStyle = K.rgba(c.accent, 0.5 * (1 - pulse) * pp);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 10 + 34 * pulse, 0, K.TAU);
        ctx.stroke();
        ctx.fillStyle = c.accent;
        ctx.beginPath();
        ctx.arc(x, y, 9 * pp, 0, K.TAU);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 3;
        ctx.stroke();
        /* label card, offset away from its neighbours */
        const lp = K.cubicOut(K.seg(lt, 1.6 + i * 0.4, 2.5 + i * 0.4));
        const f = `500 22px ${fonts.sans}`;
        ctx.font = f;
        const tw = ctx.measureText(p.label).width + 32;
        const dir = i === 1 ? -1 : 1;
        const lx = dir > 0 ? x + 26 : x - 26 - tw;
        const ly = y - 22;
        ctx.save();
        ctx.globalAlpha = lp;
        ctx.beginPath();
        ctx.roundRect(lx, ly, tw, 44, 10);
        ctx.fillStyle = "#1c1c1c";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.1)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = c.fg;
        ctx.textAlign = "left";
        ctx.fillText(p.label, lx + 16, ly + 29);
        ctx.restore();
        if (p.photo) {
          const ph = K.cubicOut(K.seg(lt, 2.8, 3.8));
          if (ph > 0) {
            const g = env.img["sig-gallery"];
            const sx = g.naturalWidth / 1440;
            const S = 240,
              SH = (S * p.photo[3]) / p.photo[2];
            const bx = x + 26,
              by = y + 40;
            ctx.save();
            ctx.globalAlpha = ph;
            ctx.shadowColor = "rgba(0,0,0,0.5)";
            ctx.shadowBlur = 30;
            ctx.beginPath();
            ctx.roundRect(bx, by + 16 * (1 - ph), S, SH, 12);
            ctx.fillStyle = "#000";
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.clip();
            ctx.drawImage(g, p.photo[0] * sx, p.photo[1] * sx, p.photo[2] * sx, p.photo[3] * sx, bx, by + 16 * (1 - ph), S, SH);
            ctx.restore();
          }
        }
      });
      /* window header, as in the app: view title */
      const hg = ctx.createLinearGradient(0, F.y, 0, F.y + 90);
      hg.addColorStop(0, "rgba(13,13,13,0.95)");
      hg.addColorStop(1, "rgba(13,13,13,0)");
      ctx.fillStyle = hg;
      ctx.fillRect(F.x, F.y, F.w, 90);
      ctx.font = `600 30px ${fonts.serif}`;
      ctx.fillStyle = c.fg;
      ctx.textAlign = "left";
      ctx.fillText("Locations", F.x + 34, F.y + 52);
      ctx.restore();
      ctx.beginPath();
      ctx.roundRect(F.x + 0.5, F.y + 0.5, F.w - 1, F.h - 1, F.r);
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.stroke();

      K.caption(ctx, env, lt, env.str.caps.gallery, { x: 120, cy: env.H / 2, w: 500, t0: -5 });
    },
  };
})();
