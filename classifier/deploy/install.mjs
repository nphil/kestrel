// Installs a wildlife classifier into Scrypted's ONNX plugin and makes it the
// animal classifier on exactly the cameras named -- no more, no fewer.
//
//   SCRYPTED_USER=... SCRYPTED_PASS=... node install.mjs \
//     --url file:///server/volume/models/wildlife-atlanta/config.json \
//     --name "Wildlife Classifier" \
//     --cameras "Front Door Camera,Back Door Camera,Bird Camera,Backyard Camera" \
//     [--replace "Bird Classifier"] [--server https://192.168.1.69:10443] [--dry-run]
//
// Safe to re-run: an existing device with --name is reused, cameras already set
// correctly are left alone. --replace detaches the named classifier from every
// camera and then deletes it (and Scrypted's cached copy of its model file).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Scrypted's LAN certificate is self-signed
import { connectScryptedClient } from '@scrypted/client';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    url: { type: 'string' },
    name: { type: 'string', default: 'Wildlife Classifier' },
    cameras: { type: 'string' },
    replace: { type: 'string' },
    server: { type: 'string', default: 'https://192.168.1.69:10443' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (!opt.url || !opt.cameras) throw new Error('--url and --cameras are required');
const KEY = 'objectdetectionplugin:134:animalClassifiers';
const ALLOW = 'objectdetectionplugin:134:allowList';
const dry = opt['dry-run'];
const wantCameras = new Set(opt.cameras.split(',').map(s => s.trim()));

const sdk = await connectScryptedClient({
  baseUrl: opt.server, pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
const sm = sdk.systemManager;
const state = sm.getSystemState();
const all = Object.keys(state).map(id => sm.getDeviceById(id));
const byName = name => all.filter(d => d.name === name);
const log = (...a) => console.log(dry ? '[dry-run]' : '', ...a);

try {
  // 1. The classifier device.
  const onnx = all.find(d => d.pluginId === '@scrypted/onnx' && d.interfaces.includes('DeviceCreator'));
  if (!onnx) throw new Error('ONNX plugin not installed');
  let classifier = byName(opt.name).find(d => d.interfaces.includes('CustomObjectDetection'));
  if (classifier) {
    log(`reusing "${opt.name}" (id ${classifier.id})`);
  } else if (!dry) {
    const id = await onnx.createDevice({ name: opt.name, url: opt.url });
    classifier = sm.getDeviceById(String(id));
    log(`created "${opt.name}" (id ${classifier.id}) from ${opt.url}`);
  } else {
    log(`would create "${opt.name}" from ${opt.url}`);
  }
  const newId = classifier?.id;
  const replaced = opt.replace ? byName(opt.replace).filter(d => d.interfaces.includes('CustomObjectDetection')) : [];
  const replacedIds = new Set(replaced.map(d => d.id));

  // 2. Cameras: the named ones get exactly the new classifier; everyone else loses
  //    the new and the replaced one.
  const cameras = all.filter(d => d.interfaces.includes('ObjectDetector') && d.interfaces.includes('VideoCamera'));
  const missing = [...wantCameras].filter(n => !cameras.some(c => c.name === n));
  if (missing.length) throw new Error(`cameras not found: ${missing.join(', ')}`);
  for (const cam of cameras) {
    const settings = Object.fromEntries((await cam.getSettings()).map(s => [s.key, s.value]));
    if (!(KEY in settings)) continue; // camera not using Scrypted NVR object detection
    const current = settings[KEY] || [];
    const kept = current.filter(id => id !== newId && !replacedIds.has(id));
    const next = wantCameras.has(cam.name) && newId ? [...kept, newId] : kept;
    if (wantCameras.has(cam.name) && !(settings[ALLOW] || []).includes('animal')) {
      log(`${cam.name}: adding "animal" to detections`);
      if (!dry) await cam.putSetting(ALLOW, [...(settings[ALLOW] || []), 'animal']);
    }
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    log(`${cam.name}: animal classifiers ${JSON.stringify(current)} -> ${JSON.stringify(next)}`);
    if (!dry) await cam.putSetting(KEY, next);
  }

  // 3. Retire the replaced classifier.
  for (const d of replaced) {
    log(`removing "${d.name}" (id ${d.id})`);
    if (!dry) await sm.removeDevice(d.id);
  }
} finally {
  sdk.disconnect();
}
process.exit(0);
