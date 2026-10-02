// Backs up every object-detection (134) and motion (135) setting of one camera as JSON: data/backup/camera<ID>_zones_<ts>.json
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const id = process.argv[2];
const sdk = await connectScryptedClient({ baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core', username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS });
const d = sdk.systemManager.getDeviceById(id);
const all = await d.getSettings();
const keep = all.filter(s => /^objectdetectionplugin:13[45]:/.test(s.key));
const out = { camera: id, name: d.name, taken: new Date().toISOString(), settings: Object.fromEntries(keep.map(s => [s.key, s.value])) };
const f = `/data/home/Kestrel/detector-eval/data/backup/camera${id}_zones_${Date.now()}.json`;
fs.writeFileSync(f, JSON.stringify(out, null, 1));
fs.appendFileSync('/data/home/Kestrel/docs/detector-changes.md', `\n**Backup (${out.taken}):** all object-detection (134) and motion (135) settings of ${d.name} (${id}) saved to \`${f}\` before the Backyard zone change.\n`);
for (const s of keep) if (/zone|zones|threshold|blur|area|dilate|allowList/i.test(s.key)) console.log(s.key, '=', JSON.stringify(s.value).slice(0, 260));
sdk.disconnect(); setTimeout(() => process.exit(0), 300);
