import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../..');

test('GPU run recycling, batching, UV copying and CPU/GPU transitions', { timeout: 180000 }, async () => {
  const server = await createServer({
    configFile: path.join(root, 'apps/demo/vite.config.mjs'),
    root: path.join(root, 'apps/demo'),
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'mesh-batch-check',
      configureServer(server) {
        server.middlewares.use('/mesh-batch-check', async (_request, response) => {
          const entry = `/@fs/${root}/tests/visual/mesh-batch.browser.js`;
          response.setHeader('Content-Type', 'text/html');
          response.end(await server.transformIndexHtml('/mesh-batch-check',
            `<link rel="icon" href="data:,"><script type="module" src="${entry}"></script>`));
        });
      },
    }],
  });
  let browser;

  try {
    await server.listen();
    browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=default'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/mesh-batch-check`);
    await page.waitForFunction(() => window.checkMeshBatch);
    assert.equal(await page.evaluate(() => window.checkRendererSerialization()), true);
    assert.equal(await page.evaluate(() => window.checkGPUEmissionRuns()), true);
    for (const backend of ['webgl', 'webgpu']) {
      console.log(backend, 'impulse count emission', await page.evaluate(
        backend => window.checkImpulseCountEmission(backend), backend));
      for (const batched of [false, true]) {
        const result = await page.evaluate(({ backend, batched }) => window.checkMaterialCopyUV(backend, batched),
          { backend, batched });
        console.log(backend, batched ? 'batched contact UV' : 'instanced contact UV', result);
      }
      for (const kind of ['flat', 'meshes', 'sprites']) {
        const result = await page.evaluate(({ backend, kind }) => window.checkMeshBatch(backend, kind),
          { backend, kind });
        console.log(backend, kind, result);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
