/* Scene "promise": three beats (3 s each). A large serif word, its one-line proof from the
   README, and the matching mascot sticker. Copy: env.str.promise. */
(function () {
  const K = window.KIT;
  SCENES["promise"] = {
    draw(ctx, lt, opts, env) {
      const { W, H, fonts, brand } = env;
      const c = brand.colors;
      const beats = env.str.promise;
      const len = env.dur / beats.length;
      K.backdrop(ctx, env, lt, 3);
      /* progress dots */
      beats.forEach((_, i) => {
        const on = lt >= i * len;
        ctx.fillStyle = on ? c.accent : K.rgba(c.fg, 0.2);
        ctx.beginPath();
        ctx.arc(W / 2 - 30 + i * 30, H - 110, on ? 6 : 5, 0, K.TAU);
        ctx.fill();
      });
      beats.forEach((b, i) => {
        const l = lt - i * len;
        if (l < 0 || l > len) return;
        const out = i < beats.length - 1 ? K.seg(l, len - 0.5, len) : 0;
        ctx.save();
        ctx.globalAlpha = 1 - out;
        const img = env.img[b.img];
        const sp = K.cubicOut(K.seg(l, 0.1, 1.2));
        const sh = 420 * (0.94 + 0.06 * sp);
        const sw = (sh * img.naturalWidth) / img.naturalHeight;
        ctx.save();
        ctx.globalAlpha *= sp;
        ctx.drawImage(img, W * 0.7 - sw / 2, H / 2 - sh / 2 - 10 + 30 * (1 - sp), sw, sh);
        ctx.restore();
        K.textIn(ctx, b.word, 200, H / 2 + 20, `400 170px ${fonts.serif}`, c.fg, K.seg(l, 0.15, 1.3), "left", -4, 30);
        K.textIn(ctx, b.sub, 206, H / 2 + 110, `400 38px ${fonts.sans}`, c.mute, K.seg(l, 0.6, 1.6), "left", 0, 16);
        ctx.restore();
      });
    },
  };
})();
