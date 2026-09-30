/* Scene "designs": the same journal in each design system and mode, real screenshots
   dissolving one into the next, each labelled. Copy: env.str.designs. */
(function () {
  const K = window.KIT;
  SCENES["designs"] = {
    draw(ctx, lt, opts, env) {
      const { fonts, brand } = env;
      const c = brand.colors;
      const D = env.str.designs;
      const F = K.FRAME;
      K.backdrop(ctx, env, lt, 8);
      const rise = 40 * (1 - K.cubicOut(K.seg(lt, 0, 1.4)));
      const step = 1.5;
      ctx.save();
      ctx.translate(0, rise);
      K.frameShadow(ctx, F, K.seg(lt, 0, 0.8));
      const v = K.camera([{ t: 0, v: [0, 0, 1440] }, { t: env.dur, v: [40, 20, 1300] }], lt);
      let label = D.shots[0][1],
        la = 1;
      D.shots.forEach(([img, name], i) => {
        const a = i === 0 ? 1 : K.cubicInOut(K.seg(lt, 0.6 + i * step, 1.2 + i * step));
        if (a <= 0) return;
        K.frame(ctx, env.img[img], v, a);
        if (a > 0.5) {
          label = name;
          la = K.clamp((a - 0.5) * 2);
        }
      });
      /* label pill, bottom-right of the window */
      const f = `500 24px ${fonts.sans}`;
      ctx.font = f;
      const tw = ctx.measureText(label).width + 44;
      const px = F.x + F.w - tw - 28,
        py = F.y + F.h - 72;
      ctx.save();
      ctx.globalAlpha = K.seg(lt, 0.6, 1.2);
      ctx.beginPath();
      ctx.roundRect(px, py, tw, 48, 24);
      ctx.fillStyle = "rgba(13,13,13,0.82)";
      ctx.fill();
      ctx.strokeStyle = K.rgba(c.accent, 0.5);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.globalAlpha *= 0.4 + 0.6 * la;
      ctx.fillStyle = c.fg;
      ctx.textAlign = "center";
      ctx.fillText(label, px + tw / 2, py + 32);
      ctx.restore();
      ctx.restore();
      K.caption(ctx, env, lt, D, { x: 120, cy: env.H / 2, w: 500, t0: 0.4 });
    },
  };
})();
