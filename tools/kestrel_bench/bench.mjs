#!/usr/bin/env -S node --experimental-strip-types --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
// Kestrel bench: make any animal show up in a test copy of Kestrel. Nothing here talks to Scrypted, Home Assistant, MQTT or the network.
//
//   node --experimental-strip-types tools/kestrel_bench/bench.mjs [serve] [--port 8770] [--no-build]
//       Starts the bench (a sandbox plugin on a temp database and the dashboard test page) and prints its address. Open /bench for the page.
//       Ctrl-C stops it and deletes its temp folder.
//   ... bench.mjs search <letters>                      find a species (works without a running bench)
//   ... bench.mjs hear <species> [--model v3|perch|disagree|v24|none] [--confidence 0.9] [--occurrence common|uncommon|rare|unknown]
//                                [--camera 88|103|104|<name>] [--other <species>] [--style nested|flat]
//   ... bench.mjs see <species> [--camera 103] [--confidence 0.9] [--label-score 0.9|none] [--no-second]
//   ... bench.mjs again | drop | reset | state          (these talk to a running bench: --url http://127.0.0.1:8770)
// Add --json to any command for the raw answer.
import { classOf } from "./sandbox.mjs";
import { loadSpecies, searchSpecies } from "./species.mjs";
import { describeSpecies, startBench } from "./server.mjs";

const USAGE = `Kestrel bench. Commands: serve, search <letters>, hear <species>, see <species>, again, drop, reset, state. See the top of tools/kestrel_bench/bench.mjs.`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let at = 0; at < argv.length; at++) {
    const item = argv[at];
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const [name, inline] = item.slice(2).split("=");
    const bare = ["json", "no-build", "no-second"].includes(name);
    flags[name] = bare ? true : inline ?? argv[++at];
  }
  return { positional, flags };
}

const print = (value, json) => console.log(json ? JSON.stringify(value, null, 2) : value);

async function serve(flags) {
  const bench = await startBench({ port: Number(flags.port ?? 8770), build: !flags["no-build"] });
  const stop = async () => { await bench.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`Kestrel bench is running (a sandbox: nothing real is touched).\n  Bench page:   ${bench.url}/bench\n  Test panel:   ${bench.url}/kestrel/wildlife?bench=1\n  Temp folder:  ${bench.sandbox.dir} (deleted when you stop)\nCtrl-C to stop.`);
}

async function remote(path, flags, body) {
  const base = String(flags.url ?? "http://127.0.0.1:8770");
  let response;
  try {
    response = await fetch(`${base}/bench/api/${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`No bench is running at ${base}. Start one first: node --experimental-strip-types tools/kestrel_bench/bench.mjs serve`);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The bench said no.");
  return data;
}

const { positional, flags } = parse(process.argv.slice(2));
const command = positional[0] ?? "serve";
const query = positional.slice(1).join(" ");
const number = (value) => (value === undefined ? undefined : Number(value));

try {
  if (command === "serve") await serve(flags);
  else if (command === "search") {
    const results = searchSpecies(loadSpecies(classOf), query, 10).map(describeSpecies);
    print(flags.json ? results : results.map((item) => `${item.heardAs ?? item.seenAs}  (${item.scientific}; ${item.group}; ${item.sources.join(" + ")})`).join("\n") || "No match. Try fewer letters.", flags.json);
  } else if (command === "hear" || command === "see") {
    if (!query) throw new Error(`Which animal? Example: bench.mjs ${command} cardinal`);
    const body = command === "hear"
      ? { species: query, model: flags.model, confidence: number(flags.confidence), occurrence: flags.occurrence, camera: flags.camera, other: flags.other, style: flags.style }
      : { species: query, camera: flags.camera, confidence: number(flags.confidence), labelScore: flags["label-score"] === "none" ? null : number(flags["label-score"]), second: flags["no-second"] ? false : undefined };
    const result = await remote(command, flags, body);
    print(flags.json ? result : result.text, flags.json);
  } else if (["again", "drop", "reset"].includes(command)) {
    const result = await remote(command, flags, {});
    print(flags.json ? result : result.text, flags.json);
  } else if (command === "state") {
    const state = await remote("state", flags);
    print(flags.json ? state : [`${state.visitCount} visit(s):`, ...state.visits.map((visit) => `  ${visit.kind} ${visit.species} on ${visit.camera}${visit.tier ? ` [${visit.tier}]` : ""}${visit.frames ? ` (${visit.frames} box frames)` : ""}  ${visit.id}`)].join("\n"), flags.json);
  } else {
    console.log(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
