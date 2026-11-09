import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../..');
const packageRequire = createRequire(path.join(root, 'packages/rzmps/package.json'));
const bvhEntry = packageRequire.resolve('three-mesh-bvh/src/index.js');

test('GPU run recycling, batching, UV copying and CPU/GPU transitions', { timeout: 180000 }, async () => {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-material-tests-'));
  const server = await createServer({
    cacheDir: cache,
    // The GPU reader and MeshBVH must use the same node layout, including during dependency optimization.
    resolve: { alias: [{ find: /^three-mesh-bvh$/, replacement: bvhEntry }] },
    optimizeDeps: { noDiscovery: true, include: [
      'three', 'three/webgpu', 'three/tsl', 'three-mesh-bvh',
      'fast-simplex-noise', 'nanoid', 'seedrandom', 'eaz', 'react', 'react-dom/client', 'lil-gui', 'lucide-react',
    ] },
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
            `<link rel="icon" href="data:,"><script type="module" src="${entry}"></script>`
            + `<script type="module" src="/@fs/${root}/tests/visual/material-refactor.browser.js"></script>`));
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
    page.on('console', message => {
      if (message.type() === 'error' || /texture units|too many samplers/i.test(message.text())) {
        errors.push(message.text());
      }
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/mesh-batch-check`);
    await page.waitForFunction(() => window.checkMeshBatch && window.checkMaterialComposite);
    console.log('WebGL display colors', await page.evaluate(() => window.checkSpriteDisplayColor()));
    console.log('native renderer parameters', await page.evaluate(() => window.checkNativeRendererParameters()));
    console.log('native initialization', await page.evaluate(() => window.checkNativeInitialization()));
    console.log('native custom initialization', await page.evaluate(() => window.checkNativeCustomInitialization()));
    console.log('managed initialization', await page.evaluate(() => window.checkManagedInitialization()));
    assert.equal(await page.evaluate(() => window.checkRendererSerialization()), true);
    console.log('bullet source isolation', await page.evaluate(() => window.checkBulletSourceFiltering()));
    assert.equal(await page.evaluate(() => window.checkGPUEmissionRuns()), true);
    console.log('WebGL bullet initialization', await page.evaluate(
      () => window.checkCornellReflections('webgl', true)));
    console.log('atlas shader reuse', await page.evaluate(() => window.checkAtlasProgramReuse()));
    for (const backend of ['webgl', 'webgpu']) {
      console.log(backend, 'atlas detail', await page.evaluate(b => window.checkAtlasDetail(b), backend));
      console.log(backend, 'capture owner exclusion', await page.evaluate(
        b => window.checkCubemapOwnerExclusion(b), backend));
      console.log(backend, 'late copy texture', await page.evaluate(b => window.checkLateCopyTexture(b), backend));
      console.log(backend, 'Cornell reflections', await page.evaluate(b => window.checkCornellReflections(b), backend));
      console.log(backend, 'bullet dust visibility', await page.evaluate(b => window.checkBulletDustVisibility(b), backend));
      console.log(backend, 'damage roughness mask', await page.evaluate(
        b => window.checkDamageRoughnessMask(b), backend));
      console.log(backend, 'normal damage mask', await page.evaluate(b => window.checkNormalDamageMask(b), backend));
      console.log(backend, 'intersection decals', await page.evaluate(b => window.checkIntersectDecals(b), backend));
      console.log(backend, 'normal channels', await page.evaluate(b => window.checkCompositeNormals(b), backend));
      console.log(backend, 'unlit normals', await page.evaluate(b => window.checkCompositeNormals(b, true), backend));
      for (const kind of ['mesh', 'sprite', 'decal']) console.log(backend, kind, 'composites',
        await page.evaluate(({ backend, kind }) => window.checkMaterialComposite(backend, kind), { backend, kind }));
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
    await fs.rm(cache, { recursive: true, force: true });
  }
});
