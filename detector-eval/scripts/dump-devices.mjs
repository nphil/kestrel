// Lists every Scrypted device: id | name | type | plugin | nativeId
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const state = sm.getSystemState();
const rows = Object.keys(state).map(id => { const d = sm.getDeviceById(id); return { id, name: d.name, type: d.type, pluginId: d.pluginId, nativeId: d.nativeId, n: d.interfaces?.length }; });
rows.sort((a, b) => Number(a.id) - Number(b.id));
for (const r of rows) console.log([r.id, r.name, r.type, r.pluginId, r.nativeId, r.n].join(' | '));
sdk.disconnect();
process.exit(0);
