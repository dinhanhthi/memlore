// Render a showcase HTML file with the local Chrome (puppeteer-core) and ffmpeg.
//
//   node capture.mjs --mode video    --src dist/video.html --lang en --fps 180 --out intro-en.mp4
//   node capture.mjs --mode sheet    --src dist/video.html --lang en --frames 30 --out sheet-en.jpg
//   node capture.mjs --mode timeline --src dist/video.html --out timeline.json
//   node capture.mjs --mode poster   --src dist/poster.html --size A4 --format pdf --out poster.pdf
//
// Other flags: --aspect 16x9|1x1|9x16, --size WxH (video/sheet) or a poster size name,
// --duration S (override, for smoke tests). Set CHROME_PATH to pick a browser.
// The page exposes window.__showcase (see modes/video.md); canvas or DOM films both work.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

const MODES = ["video", "sheet", "poster", "timeline"];
const FLAGS = [
  "mode",
  "src",
  "lang",
  "fps",
  "out",
  "aspect",
  "size",
  "format",
  "frames",
  "duration",
];
const ASPECTS = ["16x9", "1x1", "9x16"];
// Poster sizes: viewport in CSS px (96 dpi) plus exact PDF page size.
const POSTER_SIZES = {
  A4: { w: 794, h: 1123, pdfW: "210mm", pdfH: "297mm" },
  A3: { w: 1123, h: 1587, pdfW: "297mm", pdfH: "420mm" },
  letter: { w: 816, h: 1056, pdfW: "8.5in", pdfH: "11in" },
};

function fail(msg) {
  console.error(`capture: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--"))
      fail(`unexpected argument "${arg}" (flags are --name value)`);
    let [key, value] = arg.slice(2).split(/=(.*)/s);
    if (!FLAGS.includes(key))
      fail(
        `unknown flag --${key}. Known: ${FLAGS.map((f) => "--" + f).join(" ")}`,
      );
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        fail(`--${key} needs a value`);
    }
    opts[key] = value;
  }
  return opts;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    fail(`--${name} must be a positive number, got "${value}"`);
  return n;
}

function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], {
    encoding: "utf8",
  });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    fail(`CHROME_PATH points to a missing file: ${process.env.CHROME_PATH}`);
  }
  let candidates = [];
  if (process.platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    candidates = apps.flatMap((a) => [
      `/Applications/${a}`,
      path.join(os.homedir(), "Applications", a),
    ]);
  } else if (process.platform === "linux") {
    candidates = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
    ]
      .map(which)
      .filter(Boolean);
  } else if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    candidates = roots.flatMap((r) => [
      path.join(r, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
  }
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found)
    fail(
      "no Chrome, Chromium or Edge found. Install Google Chrome or set CHROME_PATH=/path/to/chrome",
    );
  return found;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
}

// Run ffmpeg with stdin piped; resolves on exit code 0, rejects otherwise.
function ffmpeg(args, { stdin = false } = {}) {
  const proc = spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    {
      stdio: [stdin ? "pipe" : "ignore", "inherit", "inherit"],
    },
  );
  const done = new Promise((resolve, reject) => {
    proc.on("error", (e) =>
      reject(
        new Error(e.code === "ENOENT" ? "ffmpeg not found on PATH" : e.message),
      ),
    );
    proc.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited with code ${code}`)),
    );
  });
  if (stdin) proc.stdin.on("error", () => {}); // an ffmpeg failure surfaces through `done`
  return { proc, done };
}

// A canvas film is read from its <canvas>; a DOM film is screenshotted at the film
// size, with the stage laid out at the page's top-left corner. See filmMode().
async function frameJpeg(page, t, info) {
  const url = await page.evaluate(
    async (t, mode) => {
      await window.__showcase.render(t);
      if (mode !== "canvas") return null;
      return document.querySelector("canvas").toDataURL("image/jpeg", 0.95);
    },
    t,
    info.mode,
  );
  if (url) return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  return Buffer.from(
    await page.screenshot({
      type: "jpeg",
      quality: 95,
      clip: { x: 0, y: 0, width: info.width, height: info.height },
    }),
  );
}

// `__showcase.mode` ("canvas" | "dom") picks how frames are read. Unset, a page whose
// first <canvas> is exactly the film size is a canvas film; anything else (no canvas,
// or DOM with small canvas layers) is screenshotted, so no part of the frame is lost.
async function filmMode(page, info) {
  const mode = await page.evaluate(
    ({ width, height }) => {
      const { mode } = window.__showcase;
      if (mode !== undefined) return mode;
      const c = document.querySelector("canvas");
      return c && c.width === width && c.height === height ? "canvas" : "dom";
    },
    { width: info.width, height: info.height },
  );
  if (mode !== "canvas" && mode !== "dom")
    throw new Error(`__showcase.mode must be "canvas" or "dom", got "${mode}"`);
  if (mode === "canvas" && !(await page.$("canvas")))
    throw new Error(`__showcase.mode is "canvas" but the page has no <canvas>`);
  return mode;
}

async function captureVideo(page, info, opts) {
  const fps = opts.fps;
  const total = Math.round(opts.duration * fps);
  // >60 fps (e.g. 180) is blended down to 60 fps for real motion blur.
  // JPEG frames are full range; convert to TV range so the output is plain yuv420p.
  const filters = [];
  if (fps > 60 && fps % 60 === 0)
    filters.push(`tmix=frames=${fps / 60},fps=60`);
  filters.push("scale=in_range=pc:out_range=tv");
  const { proc, done } = ffmpeg(
    [
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-crf",
      "19",
      "-preset",
      "slow",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      opts.out,
    ],
    { stdin: true },
  );
  let failed = null;
  done.catch((e) => {
    failed = e;
  });
  console.log(
    `video: ${total} frames at ${fps} fps (${opts.duration}s, ${info.width}x${info.height}) -> ${opts.out}`,
  );
  for (let i = 0; i < total; i++) {
    if (failed) throw failed;
    const buf = await frameJpeg(page, i / fps, info);
    if (!proc.stdin.write(buf))
      await Promise.race([once(proc.stdin, "drain"), done]);
    if ((i + 1) % 300 === 0) console.log(`  ${i + 1}/${total}`);
  }
  proc.stdin.end();
  await done;
}

async function captureSheet(page, info, opts) {
  const n = Math.max(1, Math.round(opts.frames));
  const cols = Math.min(n, Math.ceil(Math.sqrt(n * 1.2)));
  const rows = Math.ceil(n / cols);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "showcase-sheet-"));
  try {
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) * opts.duration) / n;
      fs.writeFileSync(
        path.join(tmp, `f_${String(i).padStart(4, "0")}.jpg`),
        await frameJpeg(page, t, info),
      );
      console.log(`  frame ${i + 1}: t=${t.toFixed(2)}s`);
    }
    const tileW = info.width >= info.height ? 480 : 270;
    await ffmpeg([
      "-framerate",
      "1",
      "-i",
      path.join(tmp, "f_%04d.jpg"),
      "-vf",
      `scale=${tileW}:-2,tile=${cols}x${rows}:padding=4:color=black`,
      "-frames:v",
      "1",
      "-q:v",
      "3",
      opts.out,
    ]).done;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`sheet: ${n} frames (${cols}x${rows}) -> ${opts.out}`);
}

function posterSize(size) {
  if (POSTER_SIZES[size]) return POSTER_SIZES[size];
  const m = /^(\d+)x(\d+)$/.exec(size || "");
  if (!m)
    fail(`--size must be A4, A3, letter or WxH (e.g. 1200x630), got "${size}"`);
  return { w: +m[1], h: +m[2], pdfW: `${m[1]}px`, pdfH: `${m[2]}px` };
}

async function capturePoster(page, opts) {
  const s = posterSize(opts.size);
  if (opts.format === "pdf") {
    await page.pdf({
      path: opts.out,
      width: s.pdfW,
      height: s.pdfH,
      printBackground: true,
      pageRanges: "1",
    });
  } else {
    await page.screenshot({
      path: opts.out,
      type: "png",
      clip: { x: 0, y: 0, width: s.w, height: s.h },
    });
  }
  console.log(`poster: ${opts.size} ${opts.format} -> ${opts.out}`);
}

// Abort when a declared font did not load: frames would silently use a fallback font.
async function checkFonts(page) {
  const bad = await page.evaluate(() => {
    const { fonts = [], fontSample = "" } = window.__showcase;
    const faces = [...document.fonts];
    return fonts
      .filter(({ family, weight }) => {
        const loaded = faces.some(
          (f) =>
            f.family.replace(/["']/g, "") === family && f.status === "loaded",
        );
        return (
          !loaded ||
          !document.fonts.check(`${weight} 64px "${family}"`, fontSample)
        );
      })
      .map(({ family, weight }) => `${weight} ${family}`);
  });
  if (bad.length)
    throw new Error(
      `fonts not loaded: ${bad.join(", ")} (offline, or a wrong family/weight in BRAND.fonts?)`,
    );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.mode ??= "video";
  if (!MODES.includes(opts.mode))
    fail(`--mode must be one of ${MODES.join("|")}`);
  if (!opts.src) fail("--src <file.html> is required");
  if (!fs.existsSync(opts.src)) fail(`--src not found: ${opts.src}`);
  if (!opts.out) fail("--out <file> is required");
  if (opts.aspect && !ASPECTS.includes(opts.aspect))
    fail(`--aspect must be one of ${ASPECTS.join("|")}`);
  opts.lang ??= "en";
  opts.fps = positiveNumber(opts.fps ?? 60, "fps");
  opts.frames = positiveNumber(opts.frames ?? 30, "frames");
  opts.format ??= "png";
  if (!["png", "pdf"].includes(opts.format))
    fail("--format must be png or pdf");
  if (opts.mode === "poster") opts.size ??= "1200x630";
  ensureDir(opts.out);

  const query = new URLSearchParams({ capture: "1", lang: opts.lang });
  if (opts.aspect) query.set("aspect", opts.aspect);
  if (opts.size) query.set("size", opts.size);
  const url = `${pathToFileURL(path.resolve(opts.src)).href}?${query}`;

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--hide-scrollbars", "--force-color-profile=srgb"],
  });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => console.log("page:", m.text()));
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    if (opts.mode === "poster") {
      const s = posterSize(opts.size);
      await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 2 });
    } else {
      await page.setViewport({
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
      });
    }
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction(() => Boolean(window.__showcase), {
      timeout: 30000,
    });
    await page.evaluate(() => window.__showcase.ready);
    await checkFonts(page);

    if (opts.mode === "poster") return await capturePoster(page, opts);
    const info = await page.evaluate(() => {
      const { duration, fps, width, height, timeline } = window.__showcase;
      return { duration, fps, width, height, timeline };
    });
    info.mode = await filmMode(page, info);
    // DOM films render at the viewport, so size it to the film.
    if (info.mode === "dom")
      await page.setViewport({
        width: info.width,
        height: info.height,
        deviceScaleFactor: 1,
      });
    opts.duration = opts.duration
      ? positiveNumber(opts.duration, "duration")
      : info.duration;
    if (opts.mode === "timeline") {
      fs.writeFileSync(
        opts.out,
        JSON.stringify(
          { duration: info.duration, fps: info.fps, timeline: info.timeline },
          null,
          2,
        ),
      );
      console.log(
        `timeline: ${info.timeline.length} entries, ${info.duration}s -> ${opts.out}`,
      );
    } else if (opts.mode === "sheet") {
      await captureSheet(page, info, opts);
    } else {
      await captureVideo(page, info, opts);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`capture: ${e.message}`);
  process.exit(1);
});
