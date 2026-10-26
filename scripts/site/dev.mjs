import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createServer as createDemoServer } from 'vite';
import { createServer as createDocsServer } from 'vitepress';

const root = path.resolve(import.meta.dirname, '../..');
async function reservePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  return {
    port,
    release: () => new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve())),
  };
}

export async function startSiteDev({
  port = 5173,
  host = '0.0.0.0',
  docsDirectory = path.join(root, 'apps/docs'),
  prebundle = true,
  prepareDocs = async () => {},
} = {}) {
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
  let docs, demo, restartPromise, releaseDocsPort;
  let closing = false;
  try {
    // A private ephemeral port prevents two apps from competing for the public entry port.
    const reservation = await reservePort();
    const docsPort = reservation.port;
    releaseDocsPort = reservation.release;
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
    const target = `http://127.0.0.1:${docsPort}`;
    demo = await createDemoServer({
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
      plugins: [...optimizerPlugins(), {
        name: 'rzmps-docs-reload-gate',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!/^\/docs(?:\/|\?|$)/.test(req.url || '')) return next();
            if (!docs) {
              res.statusCode = 503;
              res.setHeader('Retry-After', '5');
              res.end('Documentation is starting. Please try again shortly.');
              return;
            }
            if (!restartPromise) return next();
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
        host, port, strictPort: false,
        proxy: { '^/docs(?:/|\\?|$)': { target, ws: true } },
      },
    });
    await demo.listen();
    // Vite may select another port when the requested one is already occupied.
    port = demo.httpServer.address().port;
    // Prevent demo port fallback from taking the private docs port.
    await releaseDocsPort();
    releaseDocsPort = undefined;
    await prepareDocs(demo);
    docs = await createDocs();
    const close = async () => {
      closing = true;
      await restartPromise;
      await demo.close();
      await docs.close();
    };
    return { demo, get docs() { return docs; }, close };
  } catch (error) {
    await releaseDocsPort?.();
    await demo?.close();
    await docs?.close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let site, previewProcess;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    previewProcess?.kill(signal);
    await site?.close();
    process.exit(0);
  });
  site = await startSiteDev({
    prepareDocs: async (demo) => {
      console.log(`Demo: http://localhost:${demo.httpServer.address().port}/ — Generating documentation previews…`);
      await new Promise((resolve, reject) => {
        previewProcess = spawn('npm', ['run', 'docs:previews'], { cwd: root, stdio: 'inherit' });
        previewProcess.once('error', reject);
        previewProcess.once('exit', (code, signal) => {
          previewProcess = undefined;
          if (code === 0) resolve();
          else reject(new Error(`Documentation previews failed (${signal ?? code})`));
        });
      });
    },
  });
  console.log(`Documentation: http://localhost:${site.demo.httpServer.address().port}/docs/`);
}
