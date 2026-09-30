/* Scene "finale": logo, wordmark, tagline, the download CTA, URL and platform line.
   Everything lands by ~3.5 s and the last seconds hold still. Copy: env.str.end. */
(function () {
  const K = window.KIT;
  SCENES["finale"] = {
    draw(ctx, lt, opts, env) {
      const { W, H, fonts, brand } = env;
      const c = brand.colors;
      const e = env.str.end;
      K.backdrop(ctx, env, Math.min(lt, 3.5), 5, 0.8);
      const logo = env.img.logo;
      const lp = K.cubicOut(K.seg(lt, 0.1, 1.6));
      const s = 170;
      ctx.save();
      ctx.globalAlpha = lp;
      ctx.drawImage(logo, W / 2 - s / 2, 170 + 20 * (1 - lp), s, s);
      ctx.restore();
      K.textIn(ctx, env.str.wordmark, W / 2, 490, `400 120px ${fonts.serif}`, c.fg, K.seg(lt, 0.4, 1.6), "center", -2.5, 24);
      K.textIn(ctx, env.str.tagline, W / 2, 565, `400 36px ${fonts.sans}`, c.mute, K.seg(lt, 0.8, 1.9), "center", 0.5, 14);

      /* CTA pill, measured from its label; a press at 2.0 s */
      const f = `600 34px ${fonts.sans}`;
      ctx.font = f;
      const bw = ctx.measureText(e.cta).width + 112,
        bh = 84;
      const bp = K.cubicOut(K.seg(lt, 1.2, 2.0));
      const press = 1 - 0.04 * Math.sin(Math.PI * K.seg(lt, 2.0, 2.3));
      if (bp > 0) {
        ctx.save();
        ctx.globalAlpha = bp;
        ctx.translate(W / 2, 680 + bh / 2 + 16 * (1 - bp));
        ctx.scale(press, press);
        const g = ctx.createLinearGradient(-bw / 2, -bh / 2, bw / 2, bh / 2);
        g.addColorStop(0, c.accent2);
        g.addColorStop(1, c.fill);
        ctx.shadowColor = K.rgba(c.accent, 0.5);
        ctx.shadowBlur = 40;
        ctx.beginPath();
        ctx.roundRect(-bw / 2, -bh / 2, bw, bh, bh / 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.font = f;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText(e.cta, 0, 12);
        ctx.restore();
      }
      K.textIn(ctx, e.url, W / 2, 850, `500 34px ${fonts.mono}`, c.accent2, K.seg(lt, 1.8, 2.8), "center", 1, 10);
      K.textIn(ctx, e.meta, W / 2, 910, `400 26px ${fonts.sans}`, c.mute, K.seg(lt, 2.2, 3.2), "center", 0.5, 10);
    },
  };
})();
