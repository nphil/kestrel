// Runs the Scrypted NVR's own motion detector (its release.wasm) on frames the Python harness sends.
// The wasm and its loader glue come from YOUR Scrypted install (closed source, so they are not in git):
//   research/nvr/release.wasm       <- <scrypted volume>/plugins/@scrypted/nvr/zip/unzipped/fs/release.wasm
//   research/nvr/wasm_loader.mjs    <- the AssemblyScript loader `p` from the same plugin's motion-fork.nodejs.js
// Protocol: one JSON object per stdin line -> one JSON line on stdout.
//   {"op":"reset"}
//   {"op":"frame","raw":"/tmp/x.rgb","w":480,"h":270,"blur":2,"threshold":25,"update":true}   (raw = w*h*3 RGB bytes)
//   -> {"regions":[{"minx":..,"miny":..,"maxx":..,"maxy":..}, ...]}   (grid coordinates)
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const nvrDir = path.join(here, '..', 'research', 'nvr');
const { p } = await import(path.join(nvrDir, 'wasm_loader.mjs'));
const wasm = fs.readFileSync(path.join(nvrDir, 'release.wasm'));
const y = await WebAssembly.compile(wasm).then(m => p(m, { env: undefined }));

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const cmd = JSON.parse(line);
  try {
    if (cmd.op === 'reset') {
      y.clearPreviousBuffer();
      console.log(JSON.stringify({ ok: true }));
    } else if (cmd.op === 'frame') {
      const buf = fs.readFileSync(cmd.raw);
      const regions = y.blurDiffRegions(buf, cmd.w, cmd.h, 3, cmd.blur ?? 2, cmd.threshold ?? 25, !!cmd.update) || [];
      console.log(JSON.stringify({ regions: regions.map(r => ({ minx: r.minx, miny: r.miny, maxx: r.maxx, maxy: r.maxy })) }));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }));
  }
}
