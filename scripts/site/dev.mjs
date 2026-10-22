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

export async function startSiteDev({ port = 5173, host = '0.0.0.0', docsDirectory = path.join(root, 'apps/docs'), prebundle = true } = {}) {
  // HTTP-only integration tests do not consume the browser import graph. Letting
  // either Vite optimizer wait for those imports can stall server.close() on CI.
  const optimizerPlugins = () => prebundle ? [] : [{
    name: 'rzmps-http-only',
    configResolved(config) {
      config.optimizeDeps.include = [];
      config.optimizeDeps.noDiscovery = true;
      config.server.preTransformRequests = false;
    },
  }];
  let docs, demo, restartPromise;
  let closing = false;
  try {
    // A private ephemeral port prevents two apps from competing for the public entry port.
    const docsPort = await availablePort();
    async function createDocs() {
      const server = await createDocsServer(docsDirectory, {
        host: '127.0.0.1', port: docsPort, strictPort: true,
        hmr: { clientPort: port },
      }, () => {
        if (closing) return Promise.resolve();
        // VitePress must resolve its config again, rather than restart Vite with stale site data.
        restartPromise ??= (async () => {
          await docs.close();
          if (!closing) docs = await createDocs();
        })().finally(() => { restartPromise = undefined; });
        return restartPromise;
      });
      // VitePress accepts server options, rather than an inline Vite config.
      // Its dependency optimizer starts at listen(), so configure it first.
      for (const plugin of optimizerPlugins()) plugin.configResolved(server.config);
      try {
        // Keep the private port stable so the demo's docs proxy survives restarts.
        await server.listen(docsPort);
        return server;
      } catch (error) { await server.close(); throw error; }
    }
    docs = await createDocs();
    const target = `http://127.0.0.1:${docs.httpServer.address().port}`;
    if (!port) port = await availablePort();
    docs.config.server.hmr.clientPort = port;
    demo = await createDemoServer({
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
      plugins: [...optimizerPlugins(), {
        name: 'rzmps-docs-reload-gate',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!/^\/docs(?:\/|\?|$)/.test(req.url || '') || !restartPromise) return next();
            // Vite's HMR ping accepts any HTTP response as success. Hold it until the docs
            // server is listening so the browser cannot reload into a temporary proxy 502.
            restartPromise.then(() => next(), error => {
              res.statusCode = 503;
              res.end(`Documentation restart failed: ${error.message}`);
            });
          });
        },
      }],
      server: {
        host, port, strictPort: true,
        proxy: { '^/docs(?:/|\\?|$)': { target, ws: true } },
      },
    });
    await demo.listen();
    const close = async () => {
      closing = true;
      await restartPromise;
      await demo.close();
      await docs.close();
    };
    return { demo, get docs() { return docs; }, close };
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
