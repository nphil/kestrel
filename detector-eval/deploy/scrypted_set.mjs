// Sets ONE Scrypted device setting and appends old -> new to /data/home/Kestrel/docs/detector-changes.md (revert log).
//   node deploy/scrypted_set.mjs <deviceId> <settingKey> <value|json> [note]
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const [id, key, raw, note] = process.argv.slice(2);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const d = sdk.systemManager.getDeviceById(id);
const cur = (await d.getSettings()).find(s => s.key === key);
if (!cur) throw new Error(`setting ${key} not found on ${id}`);
let value = raw; try { value = JSON.parse(raw); } catch {}
const old = cur.value;
await d.putSetting(key, value);
const line = `| ${new Date().toISOString()} | ${d.name} (${id}) | \`${key}\` | \`${JSON.stringify(old)}\` | \`${JSON.stringify(value)}\` | ${note || ''} |\n`;
fs.appendFileSync('/data/home/Kestrel/docs/detector-changes.md', line);
console.log('set', d.name, key, JSON.stringify(old), '->', JSON.stringify(value));
sdk.disconnect(); setTimeout(() => process.exit(0), 300);
