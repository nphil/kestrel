process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
for (const id of process.argv.slice(2)) {
  const d = sdk.systemManager.getDeviceById(id);
  const info = d.info || {};
  const { ip, mac, serialNumber, managementUrl, ...rest } = info;
  console.log(id, d.name, JSON.stringify(rest));
  try {
    const opts = await d.getVideoStreamOptions();
    for (const o of opts) console.log('   stream', o.id, o.name, JSON.stringify(o.video), o.container, JSON.stringify(o.destinations||''));
  } catch (e) { console.log('   (no stream options)', e.message); }
}
sdk.disconnect(); process.exit(0);
