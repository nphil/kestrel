// Runs the live Wildlife Classifier (Scrypted device 248, read-only inference) on image files.
//   node scripts/classify_crops.mjs list.txt out.jsonl     (list.txt: one image path per line)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const [list, out] = process.argv.slice(2);
const paths = fs.readFileSync(list, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const clf = sdk.systemManager.getDeviceById(process.env.CLASSIFIER_ID || '248');
const w = fs.createWriteStream(out);
let n = 0;
for (const p of paths) {
  try {
    const mo = await sdk.mediaManager.createMediaObject(fs.readFileSync(p), 'image/jpeg');
    const t0 = Date.now();
    const r = await clf.detectObjects(mo);
    w.write(JSON.stringify({ path: p, ms: Date.now() - t0, detections: (r.detections || []).map(d => ({ className: d.className, score: d.score })) }) + '\n');
  } catch (e) {
    w.write(JSON.stringify({ path: p, error: String(e).slice(0, 200) }) + '\n');
  }
  if (++n % 50 === 0) console.error('classified', n, '/', paths.length);
}
w.end();
sdk.disconnect();
setTimeout(() => process.exit(0), 500);
