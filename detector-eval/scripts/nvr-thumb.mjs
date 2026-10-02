// node nvr-thumb.mjs <cameraId> <epochMs> <out.jpg> [width]
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const [id, t, out, width] = process.argv.slice(2);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const d = sdk.systemManager.getDeviceById(id);
const opts = width ? { resize: { width: Number(width) } } : undefined;
const mo = await d.getRecordingStreamThumbnail(Number(t), opts);
const buf = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
fs.writeFileSync(out, buf);
console.log('wrote', out, buf.length);
sdk.disconnect();
process.exit(0);
