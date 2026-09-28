import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dev/dist");
mkdirSync(out, { recursive: true });
await build({ entryPoints: [resolve(root, "dev/harness.ts")], bundle: true, outfile: resolve(out, "harness.js"), format: "esm", platform: "browser", target: "es2021", sourcemap: true, loader: { ".png": "dataurl" } });
console.log("Built the local Kestrel fixture harness.");
