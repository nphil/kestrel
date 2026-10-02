// Writes Scrypted rebroadcast RTSP URLs per camera/stream to data/rtsp-urls.json (never printed).
// Usage: node get-rtsp-urls.mjs 88 103 104 106
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const ids = process.argv.slice(2);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const out = {};
for (const id of ids) {
  const d = sdk.systemManager.getDeviceById(id);
  const settings = await d.getSettings();
  const o = { name: d.name, streams: {} };
  for (const s of settings) {
    if (s.key === 'prebuffer:rtspRebroadcastUrl' && s.subgroup?.startsWith('Stream:')) {
      const name = s.subgroup.replace('Stream: ', '');
      const res = settings.find(x => x.key === 'prebuffer:detectedResolution' && x.subgroup === s.subgroup);
      o.streams[name] = { url: s.value, resolution: res?.value };
    }
  }
  out[id] = o;
  console.log(id, d.name, Object.entries(o.streams).map(([k, v]) => `${k} (${v.resolution || '?'})`).join(', '));
}
fs.writeFileSync(new URL('../data/rtsp-urls.json', import.meta.url), JSON.stringify(out, null, 1), { mode: 0o600 });
sdk.disconnect();
process.exit(0);
