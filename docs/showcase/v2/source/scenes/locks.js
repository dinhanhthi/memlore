/* Scene "locks": the real unlock screen, then the three lock types (README.md:26) rise over
   it as cards, with the crypto line underneath. Copy: env.str.locks. */
(function () {
  const K = window.KIT;
  SCENES["locks"] = {
    draw(ctx, lt, opts, env) {
      const { fonts, brand } = env;
      const c = brand.colors;
      const L = env.str.locks;
      const F = K.FRAME;
      K.backdrop(ctx, env, lt, 7);
      const rise = 40 * (1 - K.cubicOut(K.seg(lt, 0, 1.4)));
      ctx.save();
      ctx.translate(0, rise);
      K.frameShadow(ctx, F, K.seg(lt, 0, 0.8));
      const v = K.camera(
        [
          { t: 0, v: [0, 0, 1440] },
          { t: 0.8, v: [0, 0, 1440] },
          { t: 3.2, v: [380, 230, 680] },
        ],
        lt,
      );
      K.frame(ctx, env.img["sig-lock"], v);
      /* dim the window as the cards arrive */
      const dim = K.cubicInOut(K.seg(lt, 3.0, 3.8));
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(F.x, F.y, F.w, F.h, F.r);
      ctx.fillStyle = `rgba(13,13,13,${0.72 * dim})`;
      ctx.fill();
      ctx.restore();
      ctx.restore();

      /* cards: measured wrap, equal heights */
      const n = L.cards.length,
        gap = 28,
        cw = (F.w - 80 - gap * (n - 1)) / n;
      const fT = `400 38px ${fonts.serif}`,
        fB = `400 24px ${fonts.sans}`;
      const bodies = L.cards.map(([, b]) => K.wrap(ctx, b, fB, cw - 64));
      const ch = 150 + Math.max(...bodies.map((b) => b.length)) * 34;
      const y0 = F.y + F.h / 2 - ch / 2;
      L.cards.forEach(([title], i) => {
        const p = K.cubicOut(K.seg(lt, 3.4 + i * 0.4, 4.4 + i * 0.4));
        if (p <= 0) return;
        const x = F.x + 40 + i * (cw + gap);
        const y = y0 + 40 * (1 - p);
        ctx.save();
        ctx.globalAlpha = p;
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 40;
        ctx.beginPath();
        ctx.roundRect(x, y, cw, ch, 18);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = K.rgba(c.accent, 0.35);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        /* padlock glyph */
        const gx = x + 32,
          gy = y + 36;
        ctx.strokeStyle = c.accent2;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(gx + 14, gy + 12, 9, Math.PI, 0);
        ctx.stroke();
        ctx.fillStyle = c.accent2;
        ctx.beginPath();
        ctx.roundRect(gx, gy + 12, 28, 22, 5);
        ctx.fill();
        ctx.font = `500 18px ${fonts.mono}`;
        ctx.fillStyle = c.mute;
        ctx.textAlign = "right";
        ctx.fillText(String(i + 1).padStart(2, "0"), x + cw - 30, y + 56);
        ctx.font = fT;
        ctx.fillStyle = c.fg;
        ctx.textAlign = "left";
        ctx.fillText(title, x + 32, y + 118);
        ctx.font = fB;
        ctx.fillStyle = c.mute;
        bodies[i].forEach((line, k) => ctx.fillText(line, x + 32, y + 162 + k * 34));
        ctx.restore();
      });
      K.textIn(ctx, L.crypto, F.x + F.w / 2, F.y + F.h + 110, `500 24px ${fonts.mono}`, c.mute, K.seg(lt, 5.2, 6.2), "center", 2, 10);
      K.caption(ctx, env, lt, L, { x: 120, cy: env.H / 2, w: 500, t0: 0.4 });
    },
  };
})();
