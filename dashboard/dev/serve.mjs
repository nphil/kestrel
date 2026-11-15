#!/usr/bin/env node
// Tiny static server for the Kestrel fixture page (no Home Assistant needed).
//   node dev/serve.mjs [port]      default 8765, 127.0.0.1 only; open http://127.0.0.1:8765/kestrel/live
//   import { startServer } from "./serve.mjs"; const { url, close } = await startServer({ port: 0 });
//     options: `localDir` (where `<visit id>.mp4` recordings are looked for), `routes(request, response, url)` (answers first; return true when it did)
// What it serves:
//   /dev/**                         files of dashboard/dev (build the harness first: node dev/build.mjs), never cached
//   /api/kestrel/media/<kind>/<id>  stands in for the integration's signed media route: needs `?authSig=` and refuses any other
//                                   query parameter except width/height (like Home Assistant's signed links), then answers with
//                                   fixtures/placeholder.svg, fixtures/call.mp3 (audio, audio-original, species_sound: a reference recording) or a clip
//                                   (clip: fixtures/clip.mp4, 640x360; the visits made to show 4:3 and portrait pictures get clip-4x3.mp4 and clip-3x4.mp4;
//                                   a recording of your own at fixtures/local/<visit id>.mp4 comes before all of those: see "Real data" in the README).
//                                   `reference-info/<species slug>` is JSON, not a file: who took a reference photo (see PHOTO_INFO: two credits, 204, 500).
//                                   It cannot know the harness's signing epoch: a test's request interceptor does (dev/smoke/lib).
//                                   `birdnet_spectrogram/<id>` is fixtures/spectrogram.png (514x257, like BirdNET-Go's) after a short wait, as it is drawn when asked;
//                                   an id that starts with "blank-" is a recording BirdNET-Go could not draw: 204.
//   anything else without a file extension (/kestrel/live, /lovelace/0 ...)  dev/index.html, the single-page fallback.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const devDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(devDir, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".map": "application/json", ".json": "application/json", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json" };
const MEDIA_FILE = { audio: "call.mp3", "audio-original": "call.mp3", species_sound: "call.mp3", birdnet_spectrogram: "spectrogram.png" };
/** How long BirdNET-Go takes to draw a spectrogram the first time it is asked for it (the real one needs about a second). */
const SPECTROGRAM_DRAW_MS = 600;
const ALLOWED_PARAMS = new Set(["authSig", "width", "height"]);
/** The clips of the fixture visits that show a picture of another shape than the generic 640x360 one (see dev/harness.ts). */
const CLIPS = new Map([["fixture-visit-4x3", "clip-4x3.mp4"], ["fixture-visit-3x4", "clip-3x4.mp4"]]);

/** The clip answered for a visit: its own recording in `localDir` (default: the git-ignored fixtures/local/) when there is one, else the fixture made for it, else the generic one. */
function clipFile(id, localDir) {
  const own = join(localDir, `${id}.mp4`);
  return /^[\w-]+$/.test(id) && existsSync(own) ? own : join(devDir, "fixtures", CLIPS.get(id) ?? "clip.mp4");
}

/** `reference-info/<slug>`: the credit for a species' reference photo as the integration answers it. A number is a bare status (204: nothing known, 500: a failing server); a slug not listed is 204. */
const PHOTO_INFO = {
  "common-raccoon": { source: "iNaturalist", credit: "Jane Birder", licence: "CC BY-NC", page: "https://www.inaturalist.org/photos/123" },
  "blue-jay": { source: "Wikipedia", credit: "", licence: "CC BY-SA 4.0", page: "https://en.wikipedia.org/wiki/Blue_jay" },
  "house-finch": 204,
  "tufted-titmouse": 500,
};
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

function handle(request, response, options) {
  const url = new URL(request.url ?? "/", "http://localhost");
  // A tool that serves its own pages next to the fixture page (tools/kestrel_bench) answers first: `true` means it did.
  if (options.routes?.(request, response, url)) return;
  if (request.method !== "GET" && request.method !== "HEAD") return deny(response, 405, "GET only");
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return deny(response, 400, "bad path"); }

  const media = /^\/api\/kestrel\/media\/([^/]+)\/([^/]+)$/.exec(path);
  if (media) {
    const params = [...url.searchParams.keys()];
    if (!url.searchParams.get("authSig") || params.some((name) => !ALLOWED_PARAMS.has(name))) return deny(response, 401, "Unauthorized");
    if (media[1] === "reference-info") {
      const info = PHOTO_INFO[media[2]] ?? 204;
      if (typeof info === "number") return response.writeHead(info, HEADERS).end();
      return response.writeHead(200, { ...HEADERS, "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(info));
    }
    if (media[1] === "birdnet_spectrogram") {
      if (media[2].startsWith("blank-")) return response.writeHead(204, HEADERS).end();
      setTimeout(() => sendFile(request, response, join(devDir, "fixtures", MEDIA_FILE.birdnet_spectrogram)), SPECTROGRAM_DRAW_MS);
      return;
    }
    return sendFile(request, response, media[1] === "clip" ? clipFile(media[2], options.localDir) : join(devDir, "fixtures", MEDIA_FILE[media[1]] ?? "placeholder.svg"));
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
export function startServer({ port = 0, localDir, routes } = {}) {
  const options = { localDir: localDir ?? join(devDir, "fixtures", "local"), routes };
  const server = createServer((request, response) => handle(request, response, options));
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
