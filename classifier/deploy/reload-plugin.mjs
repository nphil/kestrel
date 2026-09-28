// Reloads one Scrypted plugin (e.g. @scrypted/onnx) so it re-reads its model files.
//   SCRYPTED_USER=... SCRYPTED_PASS=... node reload-plugin.mjs @scrypted/onnx
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Scrypted's LAN certificate is self-signed
import { connectScryptedClient } from '@scrypted/client';

const pluginId = process.argv[2];
if (!pluginId) throw new Error('usage: node reload-plugin.mjs <plugin id>');
const sdk = await connectScryptedClient({
  baseUrl: process.env.SCRYPTED_URL || 'https://192.168.1.69:10443', pluginId: '@scrypted/core',
  username: process.env.SCRYPTED_USER, password: process.env.SCRYPTED_PASS,
});
try {
  await (await sdk.systemManager.getComponent('plugins')).reload(pluginId);
  console.log('reloaded', pluginId);
} finally {
  sdk.disconnect();
}
process.exit(0);
