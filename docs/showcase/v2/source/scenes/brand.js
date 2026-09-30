/* Scene "brand": the low-poly logo resolves out of a soft light, the Fraunces wordmark
   sets letter by letter, the tagline follows. Slow and settled: no bounce. */
(function () {
  const K = window.KIT;
  SCENES["brand"] = {
    draw(ctx, lt, opts, env) {
      const { W, H, fonts, brand } = env;
      const c = brand.colors;
      K.backdrop(ctx, env, lt, 2, 0.6);
      const logo = env.img.logo;
      const cy = H * 0.4;
      /* light bloom behind the logo */
      const lp = K.seg(lt, 0.2, 2.2);
      const g = ctx.createRadialGradient(W / 2, cy, 0, W / 2, cy, 520);
      g.addColorStop(0, K.rgba(c.accent2, 0.28 * K.cubicOut(lp)));
      g.addColorStop(1, K.rgba(c.accent, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      const e = K.cubicOut(K.seg(lt, 0.3, 2.4));
      const s = 300 * (0.9 + 0.1 * e) * (1 + 0.012 * lt);
      ctx.save();
      ctx.globalAlpha = e;
      const b = 14 * (1 - e);
      if (b > 0.3) ctx.filter = `blur(${b.toFixed(1)}px)`;
      ctx.drawImage(logo, W / 2 - s / 2, cy - s / 2, s, s);
      ctx.restore();

      /* wordmark: letters rise in sequence, measured so the word stays centred */
      const word = env.str.wordmark;
      const size = 150;
      const font = `400 ${size}px ${fonts.serif}`;
      ctx.font = font;
      ctx.letterSpacing = "-3px";
      const total = ctx.measureText(word).width;
      let x = W / 2 - total / 2;
      const wy = cy + s / 2 + 170;
      for (let i = 0; i < word.length; i++) {
        const ch = word[i];
        const cw = ctx.measureText(ch).width;
        K.textIn(ctx, ch, x, wy, font, c.fg, K.seg(lt, 1.6 + i * 0.09, 2.6 + i * 0.09), "left", -3, 30);
        ctx.font = font;
        ctx.letterSpacing = "-3px";
        x += cw;
      }
      ctx.letterSpacing = "0px";
      K.textIn(ctx, env.str.tagline, W / 2, wy + 90, `400 40px ${fonts.sans}`, c.mute, K.seg(lt, 3.0, 4.2), "center", 0.5, 16);
    },
  };
})();
