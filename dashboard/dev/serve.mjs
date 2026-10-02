#!/usr/bin/env node
// Tiny static server for the Kestrel fixture page (no Home Assistant needed).
//   node dev/serve.mjs [port]      default 8765, 127.0.0.1 only; open http://127.0.0.1:8765/kestrel/live
//   import { startServer } from "./serve.mjs"; const { url, close } = await startServer({ port: 0 });
// What it serves:
//   /dev/**                         files of dashboard/dev (build the harness first: node dev/build.mjs), never cached
//   /api/kestrel/media/<kind>/<id>  stands in for the integration's signed media route: needs `?authSig=` and refuses any other
//                                   query parameter except width/height (like Home Assistant's signed links), then answers with
//                                   fixtures/placeholder.svg, fixtures/call.mp3 (audio, audio-original) or fixtures/clip.mp4 (clip).
//                                   It cannot know the harness's signing epoch: a test's request interceptor does (dev/smoke/lib).
//   anything else without a file extension (/kestrel/live, /lovelace/0 ...)  dev/index.html, the single-page fallback.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const devDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(devDir, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".map": "application/json", ".json": "application/json", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json" };
const MEDIA_FILE = { clip: "clip.mp4", audio: "call.mp3", "audio-original": "call.mp3" };
const ALLOWED_PARAMS = new Set(["authSig", "width", "height"]);
const HEADERS = { "Cache-Control": "no-store" };

/** Sends `file` with Range support (Chromium will not play a video or seek audio without it). */
function sendFile(request, response, file) {
  const size = statSync(file).size;
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      response.writeHead(416, { ...HEADERS, "Content-Range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, { ...HEADERS, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (request.method === "HEAD") response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...HEADERS, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": size });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
}

function deny(response, status, message) {
  response.writeHead(status, { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" }).end(message);
}

function handle(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") return deny(response, 405, "GET only");
  const url = new URL(request.url ?? "/", "http://localhost");
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return deny(response, 400, "bad path"); }

  const media = /^\/api\/kestrel\/media\/([^/]+)\/[^/]+$/.exec(path);
  if (media) {
    const params = [...url.searchParams.keys()];
    if (!url.searchParams.get("authSig") || params.some((name) => !ALLOWED_PARAMS.has(name))) return deny(response, 401, "Unauthorized");
    return sendFile(request, response, join(devDir, "fixtures", MEDIA_FILE[media[1]] ?? "placeholder.svg"));
  }
  if (path.startsWith("/api/")) return deny(response, 404, "not found");

  if (path.startsWith("/dev/") && extname(path) !== "") {
    const file = normalize(join(root, path));
    if (!file.startsWith(join(root, "dev") + sep)) return deny(response, 403, "outside dev/");
    if (!existsSync(file) || !statSync(file).isFile()) return deny(response, 404, "not found (build the harness first: node dev/build.mjs)");
    return sendFile(request, response, file);
  }
  if (extname(path) !== "") return deny(response, 404, "not found");
  return sendFile(request, response, join(devDir, "index.html"));
}

/** Starts the server on 127.0.0.1; `port: 0` picks a free one. */
export function startServer({ port = 0 } = {}) {
  const server = createServer(handle);
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startServer({ port: Number(process.argv[2] ?? 8765) });
  console.log(`Kestrel fixture page: ${url}/kestrel/live  (?theme=flat-light|flat-dark|glass-light|glass-dark  ?toolbar=1  ?sidebar=auto|always_hidden  ?kiosk=1)`);
}
