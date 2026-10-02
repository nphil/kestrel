// Writes data/camera-config.json: the NVR object-detection + motion settings of the cameras under study
// (zones normalised to 0..1 exactly like the NVR does, thresholds, allow-list). No secrets are written.
//   node scripts/dump_camera_config.mjs 88 103 104 106
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { connectScryptedClient } from '@scrypted/client';
import fs from 'node:fs';
const ids = process.argv.slice(2);
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const norm = path => {
  if (!path) return undefined;
  const big = path.some(pt => pt.some(v => Math.abs(v) >= 2));
  return big ? path.map(pt => pt.map(v => v / 100)) : path;
};
const out = {};
for (const id of ids) {
  const d = sdk.systemManager.getDeviceById(id);
  const settings = Object.fromEntries((await d.getSettings()).map(s => [s.key, s.value]));
  const zonesFor = prefix => {
    const names = settings[`${prefix}:zones`] || [];
    return names.map(name => ({
      name,
      path: norm(typeof settings[`${prefix}:zone-${name}`] === 'string' ? JSON.parse(settings[`${prefix}:zone-${name}`]) : settings[`${prefix}:zone-${name}`]),
      filterMode: settings[`${prefix}:zoneinfo-filterMode-${name}`] ?? 'Default',
      type: settings[`${prefix}:zoneinfo-type-${name}`] ?? 'Intersect',
      classes: settings[`${prefix}:zoneinfo-classes-${name}`] ?? [],
    }));
  };
  const o = 'objectdetectionplugin:134', m = 'objectdetectionplugin:135';
  out[id] = {
    name: d.name,
    detection: {
      allowList: settings[`${o}:allowList`] || [],
      animalThreshold: settings[`${o}:animalSecondPassThreshold`],
      personThreshold: settings[`${o}:personSecondPassThreshold`],
      vehicleThreshold: settings[`${o}:vehicleSecondPassThreshold`],
      animalClassifiers: settings[`${o}:animalClassifiers`] || [],
      zones: zonesFor(o),
    },
    motion: settings[`${m}:zones`] !== undefined || settings[`${m}:threshold`] !== undefined ? {
      threshold: settings[`${m}:threshold`], blur: settings[`${m}:blur`], area: settings[`${m}:area`], dilate: settings[`${m}:dilate`],
      zones: zonesFor(m),
    } : null,
  };
}
fs.writeFileSync(new URL('../data/camera-config.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('wrote camera-config.json for', ids.join(','));
sdk.disconnect(); process.exit(0);
