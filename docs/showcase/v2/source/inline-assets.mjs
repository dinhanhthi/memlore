// Inline local assets into one self-contained HTML file.
//
//   node inline-assets.mjs --src video.html --out dist/video.html [--root <dir>]
//
// Inlines local <script src>, <link rel="stylesheet" href>, <img src> and CSS url(...)
// as inline code or data URIs. http(s), protocol-relative, data: and # URLs are left alone.
// Local refs must resolve inside --root (default: the git toplevel of the --src folder,
// else the --src folder); anything outside is rejected.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function fail(msg) {
  console.error(`inline-assets: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(src|out|root)(?:=(.*))?$/.exec(argv[i]);
    if (!m)
      fail(
        `unknown argument "${argv[i]}". Usage: --src <html> --out <file> [--root <dir>]`,
      );
    opts[m[1]] = m[2] ?? argv[++i];
  }
  if (!opts.src || !opts.out)
    fail(
      "usage: node inline-assets.mjs --src <html> --out <file> [--root <dir>]",
    );
  return opts;
}

const isRemote = (url) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url.trim());

// Git toplevel of dir when available, else dir itself.
function defaultRoot(dir) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
  });
  const top = git.status === 0 ? git.stdout.trim() : "";
  return top ? path.resolve(top) : dir;
}

let root = "";

function localPath(url, baseDir) {
  const clean = decodeURI(url.trim().replace(/[?#].*$/, ""));
  const file = path.resolve(baseDir, clean);
  if (!fs.existsSync(file))
    fail(`missing local asset "${url}" (looked for ${file})`);
  // Compare real paths so symlinks cannot escape root either.
  const rel = path.relative(root, fs.realpathSync(file));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    fail(
      `asset "${url}" resolves outside --root ${root} (${file}); move it inside or pass a wider --root`,
    );
  return file;
}

function dataUri(file) {
  const mime =
    MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

// CSS url(...) -> data URI, resolved against the CSS file's own folder.
function inlineCssUrls(css, baseDir) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, url) =>
    isRemote(url) ? all : `url("${dataUri(localPath(url, baseDir))}")`,
  );
}

const attr = (tag, name) => {
  const m = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};
const dropAttr = (tag, name) =>
  tag.replace(
    new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "i"),
    "",
  );

function inline(html, baseDir) {
  // <script src="local.js"></script> -> <script>...</script>
  html = html.replace(/<script\b[^>]*>\s*<\/script>/gi, (tag) => {
    const src = attr(tag, "src");
    if (!src || isRemote(src)) return tag;
    const code = fs
      .readFileSync(localPath(src, baseDir), "utf8")
      .replace(/<\/script/gi, "<\\/script");
    return `${dropAttr(tag.replace(/<\/script>$/i, ""), "src")}\n${code}\n</script>`;
  });
  // <link rel="stylesheet" href="local.css"> -> <style>...</style>
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = attr(tag, "href");
    if (!/stylesheet/i.test(attr(tag, "rel") || "") || !href || isRemote(href))
      return tag;
    const file = localPath(href, baseDir);
    return `<style>\n${inlineCssUrls(fs.readFileSync(file, "utf8"), path.dirname(file))}\n</style>`;
  });
  // <img src="local.png"> -> data URI
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = attr(tag, "src");
    if (!src || isRemote(src)) return tag;
    return tag.replace(
      /(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
      `$1"${dataUri(localPath(src, baseDir))}"`,
    );
  });
  // url(...) inside <style> blocks and style="" attributes
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (all, open, css, close) => open + inlineCssUrls(css, baseDir) + close,
  );
  html = html.replace(
    /(\sstyle\s*=\s*")([^"]*)(")/gi,
    (all, open, css, close) =>
      open + inlineCssUrls(css, baseDir).replace(/"/g, "'") + close,
  );
  return html;
}

const opts = parseArgs(process.argv.slice(2));
if (!fs.existsSync(opts.src)) fail(`--src not found: ${opts.src}`);
if (opts.root && !fs.existsSync(opts.root))
  fail(`--root not found: ${opts.root}`);
const srcDir = path.dirname(path.resolve(opts.src));
root = fs.realpathSync(
  opts.root ? path.resolve(opts.root) : defaultRoot(srcDir),
);
const html = inline(fs.readFileSync(opts.src, "utf8"), srcDir);
fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
fs.writeFileSync(opts.out, html);
console.log(
  `inline-assets: ${opts.src} -> ${opts.out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`,
);
