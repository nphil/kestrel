// Backyard (88) only: add motion zone 'Yard' (135, Intersect) + set object zone 'Grass' (134) classes to animal only. Logs old -> new.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const sdk = await connectScryptedClient({ baseUrl: 'https://192.168.1.69:10443', pluginId: '@scrypted/core', username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS });
const d = sdk.systemManager.getDeviceById('88');
const get = async k => (await d.getSettings()).find(s => s.key === k);
const log = (k, o, n, note) => fs.appendFileSync('/data/home/Kestrel/docs/detector-changes.md', `| ${new Date().toISOString()} | ${d.name} (88) | \`${k}\` | \`${JSON.stringify(o)}\` | \`${JSON.stringify(n)}\` | ${note} |\n`);
const M = 'objectdetectionplugin:135:', O = 'objectdetectionplugin:134:';
const yard = [[0.098, 0.238], [0.215, 0.148], [0.745, 0.248], [0.745, 0.995], [0.351, 0.999], [0.115, 0.688]];
const path = await get(M + 'zone-Path');
const asString = typeof path.value === 'string';
console.log('zone-Path stored as', asString ? 'string' : 'array');
const set = async (k, v, note) => { const o = (await get(k))?.value; await d.putSetting(k, v); log(k, o, v, note); console.log('set', k, JSON.stringify(o)?.slice(0, 80), '->', JSON.stringify(v).slice(0, 120)); await new Promise(r => setTimeout(r, 1500)); };
const zones = (await get(M + 'zones')).value || [];
if (!zones.includes('Yard')) await set(M + 'zones', [...zones, 'Yard'], 'Backyard: add motion zone Yard (Path untouched). Revert: zones back to ["Path"]');
await set(M + 'zone-Yard', asString ? JSON.stringify(yard) : yard, 'Yard polygon (normalised) = lawn without the brush right of the tree');
await set(M + 'zoneinfo-type-Yard', 'Intersect', 'Yard motion zone type');
await set(M + 'zoneinfo-filterMode-Yard', 'include', 'Yard motion zone filter mode');
await set(O + 'zoneinfo-classes-Grass', ['animal'], 'Backyard: Grass object zone animal only. Revert: ["person","animal"]');
// read back
for (const k of [M + 'zones', M + 'zone-Path', M + 'zone-Yard', M + 'zoneinfo-type-Yard', M + 'zoneinfo-filterMode-Yard', M + 'zoneinfo-type-Path', O + 'zones', O + 'zoneinfo-classes-Grass', O + 'zoneinfo-classes-Path', O + 'allowList']) {
  const s = await get(k); console.log('readback', k, s ? JSON.stringify(s.value).slice(0, 150) : 'MISSING');
}
sdk.disconnect(); setTimeout(() => process.exit(0), 300);
