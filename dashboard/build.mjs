import { build } from "esbuild";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(root, "../custom_components/kestrel/frontend");
const result = await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  write: false,
  outfile: resolve(root, ".build/kestrel.js"),
  format: "esm",
  platform: "browser",
  target: "es2021",
  minify: true,
  legalComments: "none",
  loader: { ".png": "dataurl" },
  metafile: true,
});
const bundles = result.outputFiles.filter((file) => file.path.endsWith(".js"));
if (bundles.length !== 1) throw new Error(`Expected one JavaScript bundle; got ${bundles.length}.`);
const bytes = bundles[0].contents;
const gzipBytes = gzipSync(bytes, { level: 9 }).byteLength;
if (gzipBytes > 80 * 1024) throw new Error(`Kestrel bundle is ${gzipBytes} bytes gzipped; limit is 81920 bytes.`);
const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const filename = `kestrel.${digest}.js`;
mkdirSync(outDir, { recursive: true });
for (const old of readdirSync(outDir)) {
  if (/^kestrel\.[a-f0-9]{16}\.js$/.test(old) && old !== filename) unlinkSync(resolve(outDir, old));
}
writeFileSync(resolve(outDir, filename), bytes);
console.log(`Built ${filename} (${gzipBytes} bytes gzipped).`);
