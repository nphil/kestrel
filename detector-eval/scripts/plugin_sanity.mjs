// Read-only sanity check of the live ONNX detector (device 152): runs detectObjects on image files, prints top detections.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const sdk = await connectScryptedClient({ baseUrl: 'https://192.168.1.69:10443', pluginId: '@scrypted/core', username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS });
const det = sdk.systemManager.getDeviceById('152');
const model = await det.getDetectionModel();
console.log('plugin model:', model.name, 'inputSize', JSON.stringify(model.inputSize), 'classes', JSON.stringify(model.classes));
for (const p of process.argv.slice(2)) {
  const mo = await sdk.mediaManager.createMediaObject(fs.readFileSync(p), 'image/jpeg');
  const t0 = Date.now();
  const r = await det.detectObjects(mo);
  const best = {};
  for (const d of r.detections || []) best[d.className] = Math.max(best[d.className] || 0, d.score);
  console.log(p.split('/').slice(-2).join('/'), Date.now() - t0, 'ms', JSON.stringify(Object.fromEntries(Object.entries(best).map(([k, v]) => [k, +v.toFixed(2)]))));
}
sdk.disconnect(); setTimeout(() => process.exit(0), 300);
