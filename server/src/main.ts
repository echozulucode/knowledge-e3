import { createApp } from './bootstrap.js';
import { loadServerConfig } from './config/server-config.js';

async function main() {
  const app = await createApp();
  const port = process.env['PORT']
    ? Number.parseInt(process.env['PORT'], 10)
    : loadServerConfig().server.port;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[kp/server] listening on :${port}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
