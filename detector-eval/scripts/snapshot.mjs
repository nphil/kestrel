// node snapshot.mjs <cameraId> <out.jpg>   -- current snapshot via takePicture()
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const [id, out] = process.argv.slice(2);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const d = sdk.systemManager.getDeviceById(id);
const mo = await d.takePicture();
const buf = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
fs.writeFileSync(out, buf);
console.log('wrote', out, buf.length);
sdk.disconnect();
process.exit(0);
