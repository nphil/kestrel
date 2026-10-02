// Dumps one device's settings (secrets masked): node dump-settings.mjs <deviceId> [filterRegex]
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
const [id, filter] = process.argv.slice(2);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const d = sdk.systemManager.getDeviceById(id);
const re = filter ? new RegExp(filter, 'i') : null;
const mask = v => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(v);
  if (/:\/\/|password|token|secret/i.test(s)) return '«masked»';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
};
console.log('DEVICE', d.id, d.name, d.pluginId, JSON.stringify(d.interfaces));
if (d.getSettings) {
  const settings = await d.getSettings();
  for (const s of settings) {
    if (/password|token|secret|credential/i.test(s.key + s.title)) { console.log(`- [${s.group||''}/${s.subgroup||''}] ${s.key} (${s.title}) = «masked»`); continue; }
    const line = `- [${s.group||''}/${s.subgroup||''}] ${s.key} (${s.title}) [${s.type||'string'}${s.multiple?',multi':''}${s.readonly?',ro':''}] = ${mask(s.value)}` + (s.choices ? `  choices=${mask(s.choices)}` : '') + (s.description ? `\n      desc: ${s.description.slice(0,400)}` : '');
    if (!re || re.test(line)) console.log(line);
  }
}
sdk.disconnect();
process.exit(0);
