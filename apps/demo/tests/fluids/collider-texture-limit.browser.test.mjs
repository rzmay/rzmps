import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './openFixture.mjs';

test('many fluid colliders share occupancy sampling under baseline WebGPU texture limits',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid-collider.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      const result = await page.evaluate(() => window.manyFluidColliders());
      console.log(JSON.stringify(result));
      assert.deepEqual(errors, []);
      assert(result.fields > result.limit);
      assert(result.error < 1e-5, 'atlas must preserve direct trilinear occupancy samples');
      assert(result.occupied > 0 && result.finite);
      assert(result.reused && result.released);
      assert(result.boundaryError < 1e-5 && result.solidError === 0, JSON.stringify(result));

      const shared = await page.evaluate(() => window.manyFluidColliders(true));
      assert.equal(shared.uniqueFields, 1);
      assert(!shared.compact && shared.boundaryError < 1e-5 && shared.solidError === 0, JSON.stringify(shared));

      // Reproduce the reported preset/scene combination with automatic collider discovery.
      const roomFixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${roomFixture}`
        + '?example=volumetricSmoke&scene=lightProbes', errors, { timeout: 30000 });
      const room = await page.evaluate(async () => {
        const { system, flip: gas, renderer, scene, camera, sceneLifecycle } = window.debugFluid;
        await system.prepare(renderer);
        for (let i = 0; i < 60; i++) {
          sceneLifecycle.update(1 / 60);
          system.advanceFrames(1, 1 / 60);
          await renderer.renderAsync(scene, camera);
        }
        await renderer.backend.device.queue.onSubmittedWorkDone();
        const state = new Float32Array(await renderer.getArrayBufferAsync(gas.boundaryAttribute));
        const density = new Float32Array(await renderer.getArrayBufferAsync(gas.densityCurrent.value));
        let mass = 0;
        for (let i = 0; i < density.length; i += 4) mass += density[i] * gas.cellSize ** 3;

        const bake = async () => {
          gas.solidStateKey = '';
          gas.computeSolidField({ system, deltaTimeNode: gas.boundaryDt }, renderer);
          return new Float32Array(await renderer.getArrayBufferAsync(gas.boundaryAttribute));
        };
        const compact = await bake(), createQuery = gas.colliderAtlas.createQuery;
        let boundaryError = 0;
        try {
          gas.colliderAtlas.createQuery = () => undefined;
          gas.solidNode = gas.solidFreshNode = undefined;
          const reference = await bake();
          for (let i = 0; i < reference.length; i++) {
            boundaryError = Math.max(boundaryError, Math.abs(reference[i] - compact[i]));
          }
        } finally {
          gas.colliderAtlas.createQuery = createQuery;
          gas.solidNode = gas.solidFreshNode = undefined;
        }

        camera.position.set(3, 2, 3); camera.lookAt(0, 1.5, 0);
        const volume = system.renderers.find(renderer => renderer.constructor.name === 'VolumeRenderer');
        const mesh = volume.mesh;
        const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
        const context = canvas.getContext('2d');
        const capture = async visible => {
          mesh.visible = visible;
          await renderer.renderAsync(scene, camera);
          context.drawImage(renderer.domElement, 0, 0);
          return context.getImageData(0, 0, 800, 600).data;
        };
        const hidden = await capture(false), shown = await capture(true);
        let visiblePixels = 0;
        for (let i = 0; i < shown.length; i += 4) {
          if (Math.max(...[0, 1, 2].map(c => Math.abs(shown[i + c] - hidden[i + c]))) > 2) visiblePixels++;
        }
        return { colliders: gas.collectedColliders.size, atlas: !!gas.colliderAtlas.texture,
          finite: state.every(Number.isFinite), mass, visiblePixels, boundaryError,
          compact: !!gas.colliderAtlas.queryAttribute };
      });
      console.log('light probes room', JSON.stringify(room));
      assert.deepEqual(errors, []);
      assert(room.atlas && room.compact && room.finite && room.colliders > 16);
      assert(room.mass > 0.001, `room must retain smoke: ${JSON.stringify(room)}`);
      assert(room.visiblePixels > 20, `room must visibly render smoke: ${JSON.stringify(room)}`);
      assert(room.boundaryError < 1e-5, `compact quadrature must match individual colliders: ${JSON.stringify(room)}`);
      await page.screenshot({ path: '/tmp/rzmps-smoke-light-probes.png' });
    } finally { await browser?.close(); await site.close(); }
  });
