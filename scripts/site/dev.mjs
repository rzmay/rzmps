import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createServer as createDemoServer } from 'vite';
import { createServer as createDocsServer } from 'vitepress';

const root = path.resolve(import.meta.dirname, '../..');
async function availablePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function startSiteDev({ port = 5173, host = '0.0.0.0' } = {}) {
  let docs, demo;
  try {
    // A private ephemeral port prevents two apps from competing for the public entry port.
    const docsPort = await availablePort();
    docs = await createDocsServer(path.join(root, 'apps/docs'), {
      host: '127.0.0.1', port: docsPort, strictPort: true,
      hmr: { clientPort: port },
    });
    // An explicit listen port also overrides the standalone VitePress port in its config.
    await docs.listen(docsPort);
    const target = `http://127.0.0.1:${docs.httpServer.address().port}`;
    if (!port) port = await availablePort();
    docs.config.server.hmr.clientPort = port;
    demo = await createDemoServer({
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
      server: {
        host, port, strictPort: true,
        proxy: { '^/docs(?:/|\\?|$)': { target, ws: true } },
      },
    });
    await demo.listen();
    const close = async () => { await demo.close(); await docs.close(); };
    return { demo, docs, close };
  } catch (error) {
    await demo?.close();
    await docs?.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = await startSiteDev();
  console.log('Demo: http://localhost:5173/ — Documentation: http://localhost:5173/docs/');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    await site.close();
    process.exit(0);
  });
}
