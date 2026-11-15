// The bench's server: the dashboard's own fixture server (dashboard/dev/serve.mjs) with the bench added to it on the same address, so the bench page and the
// Kestrel page it controls are one origin and the page can reach into the other to push live events. It listens on 127.0.0.1 only.
//   /bench                 the bench page (page.html)
//   /bench/api/*           search, state, hear, see, again, drop, reset (JSON; a POST must be application/json, which a web page on another site cannot send quietly)
//   /dev/fixtures/local/bench.json   what the sandbox plugin holds, as the harness reads it (`?bench=1`)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../dashboard/dev/serve.mjs";
import { Sandbox } from "./sandbox.mjs";
import { searchSpecies, heardName, seenName } from "./species.mjs";
import { MODELS, OCCURRENCE } from "./shapes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(here, "../../dashboard");

/** A species entry as the page and the CLI list it. */
export const describeSpecies = (item) => ({ scientific: item.scientific, heardAs: heardName(item), seenAs: seenName(item), group: item.group, sources: item.sources });

/** One action of the API: the sandbox call it makes, and what it is told in the body. */
const ACTIONS = {
  hear: (sandbox, body) => sandbox.hear({ species: body.species, model: body.model, confidence: body.confidence, occurrence: body.occurrence, camera: body.camera, style: body.style, other: body.other, detectionId: body.detectionId }),
  see: (sandbox, body) => sandbox.see({ species: body.species, camera: body.camera, confidence: body.confidence, labelScore: body.labelScore, second: body.second }),
  again: (sandbox) => sandbox.again(),
  drop: (sandbox) => sandbox.drop(),
  reset: (sandbox) => sandbox.reset(),
};

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("The request body is not JSON.")); }
    });
    request.on("error", reject);
  });
}

/** What the page shows after every action: the options it offers, the newest visits in plain terms, the log and the last message the plugin was sent. */
export function benchState(sandbox) {
  const { visits, log, sent, cameras } = sandbox.exportBench();
  return {
    cameras,
    models: Object.keys(MODELS).concat("disagree"),
    occurrences: Object.keys(OCCURRENCE),
    visits: visits.slice(0, 12).map((visit) => sandbox.summary(visit.id)),
    visitCount: visits.length,
    log: log.slice(-12).reverse(),
    sent,
    canDrop: sandbox.created.length > 0,
    canAgain: !!sandbox.last,
  };
}

/** The `routes` hook for startServer. */
export function benchRoutes(sandbox, page) {
  return (request, response, url) => {
    if (url.pathname === "/dev/fixtures/local/bench.json") {
      const { visits, species } = sandbox.exportBench();
      sendJson(response, 200, { visits, species });
      return true;
    }
    if (url.pathname === "/bench") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page());
      return true;
    }
    if (!url.pathname.startsWith("/bench/api/")) return false;
    const name = url.pathname.slice("/bench/api/".length);
    if (request.method === "GET" && name === "search") {
      sendJson(response, 200, { results: searchSpecies(sandbox.species, url.searchParams.get("q") ?? "", 8).map(describeSpecies) });
    } else if (request.method === "GET" && name === "state") {
      sendJson(response, 200, benchState(sandbox));
    } else if (request.method === "POST" && Object.hasOwn(ACTIONS, name)) {
      if (!String(request.headers["content-type"] ?? "").startsWith("application/json")) {
        sendJson(response, 415, { error: "Send JSON (Content-Type: application/json)." });
        return true;
      }
      readBody(request)
        .then((body) => ACTIONS[name](sandbox, body))
        .then((result) => sendJson(response, 200, { ...result, state: benchState(sandbox) }))
        .catch((error) => sendJson(response, 400, { error: error.message }));
    } else {
      sendJson(response, 404, { error: "No such bench call." });
    }
    return true;
  };
}

/** Rebuilds dashboard/dev/dist/harness.js so the page shows the current dashboard code (about a second). */
export function buildHarness() {
  execFileSync(process.execPath, ["dev/build.mjs"], { cwd: DASHBOARD, stdio: "pipe" });
}

/**
 * Starts a sandbox plugin and serves it with the dashboard test page and the bench page. `close()` stops the server and deletes the sandbox's folder.
 * `root` is where the temp folder goes; `build: false` skips rebuilding the test page.
 */
export async function startBench({ port = 8770, root, build = true } = {}) {
  if (build) buildHarness();
  const sandbox = new Sandbox({ root });
  try {
    const pagePath = join(here, "page.html");
    const server = await startServer({ port, localDir: sandbox.localDir, routes: benchRoutes(sandbox, () => readFileSync(pagePath, "utf8")) });
    return {
      url: server.url,
      sandbox,
      close: async () => { await server.close(); sandbox.close(); },
    };
  } catch (error) {
    sandbox.close();
    throw error;
  }
}
