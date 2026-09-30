/* Scene "cold-open": three serif lines surface one after another out of the dark, word by word,
   then the first two recede so the last one holds. Copy: env.str.cold. */
(function () {
  const K = window.KIT;
  SCENES["cold-open"] = {
    draw(ctx, lt, opts, env) {
      const { W, H, fonts, brand } = env;
      const c = brand.colors;
      K.backdrop(ctx, env, lt, 1, K.seg(lt, 0, 3) * 0.8);
      const lines = env.str.cold;
      const size = 88;
      const font = `400 ${size}px ${fonts.serif}`;
      const lh = size * 1.3;
      const y0 = H / 2 - ((lines.length - 1) * lh) / 2 + size * 0.32;
      ctx.font = font;
      lines.forEach((line, i) => {
        const words = line.split(" ");
        const widths = words.map((w) => ctx.measureText(w + " ").width);
        const total = widths.reduce((a, b) => a + b, 0) - ctx.measureText(" ").width;
        let x = W / 2 - total / 2;
        const start = 0.6 + i * 1.7;
        /* the last line stays bright; earlier lines dim once it arrives */
        const dim = i < lines.length - 1 ? 1 - 0.65 * K.seg(lt, 0.6 + (lines.length - 1) * 1.7, 0.6 + (lines.length - 1) * 1.7 + 1.2) : 1;
        ctx.save();
        ctx.globalAlpha = dim;
        words.forEach((w, k) => {
          const p = K.seg(lt, start + k * 0.16, start + k * 0.16 + 1.1);
          K.textIn(ctx, w, x, y0 + i * lh, font, i === lines.length - 1 ? c.fg : c.mute, p, "left", -1, 18);
          x += widths[k];
        });
        ctx.restore();
      });
    },
  };
})();
