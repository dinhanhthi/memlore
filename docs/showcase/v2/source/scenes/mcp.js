/* Scene "mcp": the local MCP server's six journal tools (CHANGELOG.md v0.2.0) listed in a mono
   panel, one by one, beside the caption. Copy: env.str.mcp. */
(function () {
  const K = window.KIT;
  SCENES["mcp"] = {
    draw(ctx, lt, opts, env) {
      const { fonts, brand } = env;
      const c = brand.colors;
      const m = env.str.mcp;
      K.backdrop(ctx, env, lt, 6);
      const P = { x: 820, y: 250, w: 880, h: 580, r: 18 };
      const pp = K.cubicOut(K.seg(lt, 0.1, 1.1));
      ctx.save();
      ctx.globalAlpha = pp;
      ctx.translate(0, 30 * (1 - pp));
      K.frameShadow(ctx, P);
      ctx.beginPath();
      ctx.roundRect(P.x, P.y, P.w, P.h, P.r);
      ctx.fillStyle = "#141414";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.stroke();
      /* title bar */
      ["#ff5f57", "#febc2e", "#28c840"].forEach((col, i) => {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(P.x + 34 + i * 26, P.y + 34, 7, 0, K.TAU);
        ctx.fill();
      });
      ctx.font = `500 21px ${fonts.mono}`;
      ctx.fillStyle = c.mute;
      ctx.textAlign = "center";
      ctx.fillText(m.panel, P.x + P.w / 2, P.y + 41);
      ctx.fillStyle = c.line;
      ctx.fillRect(P.x, P.y + 68, P.w, 1);
      /* tools */
      m.tools.forEach((tool, i) => {
        const tp = K.seg(lt, 1.2 + i * 0.28, 1.7 + i * 0.28);
        const y = P.y + 128 + i * 62;
        if (tp <= 0) return;
        ctx.save();
        ctx.globalAlpha *= K.cubicOut(tp);
        ctx.fillStyle = c.accent;
        ctx.font = `500 30px ${fonts.mono}`;
        ctx.textAlign = "left";
        ctx.fillText("›", P.x + 44, y);
        /* typed: characters appear over the step */
        const n = Math.ceil(tool.length * K.clamp(tp * 1.4));
        ctx.fillStyle = c.fg;
        ctx.fillText(tool.slice(0, n), P.x + 80, y);
        ctx.restore();
      });
      /* footer */
      const fp = K.seg(lt, 3.3, 4.2);
      ctx.fillStyle = c.line;
      ctx.fillRect(P.x, P.y + P.h - 76, P.w, 1);
      K.textIn(ctx, m.foot, P.x + 44, P.y + P.h - 30, `500 22px ${fonts.sans}`, c.mute, fp, "left", 0.3, 6);
      ctx.restore();
      K.caption(ctx, env, lt, m, { x: 120, cy: env.H / 2, w: 620, t0: 0.3 });
    },
  };
})();
