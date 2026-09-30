/* Scene "screen": a real Memlore screenshot in its window, filmed by a slow camera, beside a
   caption column. opts.shot picks a SHOTS entry. Views are [x, y, w] in the screenshot's
   1440x900 CSS space; highlight rects were measured on the website demo (shoot.mjs). */
(function () {
  const K = window.KIT;
  const FULL = [0, 0, 1440];
  const SHOTS = {
    write: {
      cap: "write",
      layers: [{ img: "sig-write", from: 0, keys: [{ t: 0, v: FULL }, { t: 2.2, v: FULL }, { t: 7.5, v: [540, 70, 860] }, { t: 14, v: [560, 105, 800] }] }],
    },
    find: {
      cap: "find",
      layers: [
        { img: "sig-search", from: 0, keys: [{ t: 0, v: FULL }, { t: 1.2, v: FULL }, { t: 3.4, v: [470, 110, 680] }], ring: { r: [950, 192, 140, 30], t0: 3.2, t1: 6.0 } },
        { img: "sig-lookback", from: 6.0, keys: [{ t: 6.0, v: FULL }, { t: 6.8, v: FULL }, { t: 9.5, v: [130, 40, 720] }], ring: { r: [160, 64, 318, 42], t0: 9.3, t1: 12 } },
      ],
    },
    gallery: {
      cap: "gallery",
      layers: [{ img: "sig-gallery", from: 0, keys: [{ t: 0, v: FULL }, { t: 0.8, v: FULL }, { t: 6, v: [150, 100, 980] }] }],
    },
    mood: {
      cap: "mood",
      layers: [{ img: "sig-stats", from: 0, keys: [{ t: 0, v: FULL }, { t: 0.8, v: FULL }, { t: 3.6, v: [770, 380, 680] }] }],
    },
    chat: {
      cap: "chat",
      layers: [{ img: "sig-chat", from: 0, keys: [{ t: 0, v: FULL }, { t: 1.0, v: FULL }, { t: 7, v: [560, 50, 880] }] }],
    },
    sync: {
      cap: "sync",
      layers: [{ img: "sig-sync", from: 0, keys: [{ t: 0, v: FULL }, { t: 1.0, v: FULL }, { t: 4.5, v: [360, 170, 760] }] }],
    },
  };

  SCENES["screen"] = {
    draw(ctx, lt, opts, env) {
      const s = SHOTS[opts.shot];
      const F = K.FRAME;
      K.backdrop(ctx, env, lt, opts.shot.length);
      /* the window drifts in from slightly lower and settles */
      const rise = 40 * (1 - K.cubicOut(K.seg(lt, 0, 1.4)));
      ctx.save();
      ctx.translate(0, rise);
      K.frameShadow(ctx, F, K.seg(lt, 0, 0.8));
      s.layers.forEach((L, i) => {
        const a = i === 0 ? 1 : K.cubicInOut(K.seg(lt, L.from, L.from + 0.7));
        if (a <= 0) return;
        const next = s.layers[i + 1];
        if (next && lt > next.from + 0.7) return;
        const v = K.camera(L.keys, lt);
        K.frame(ctx, env.img[L.img], v, a);
        if (L.ring) {
          const rp = K.seg(lt, L.ring.t0, L.ring.t0 + 0.6) * (1 - K.seg(lt, L.ring.t1 - 0.4, L.ring.t1));
          K.ring(ctx, env, v, L.ring.r, rp * a);
        }
      });
      ctx.restore();
      K.caption(ctx, env, lt, env.str.caps[s.cap], { x: 120, cy: env.H / 2, w: 500, t0: 0.4 });
    },
  };
})();
