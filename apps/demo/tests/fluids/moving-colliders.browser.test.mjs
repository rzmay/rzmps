import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

for (const example of ['volumetricSmoke', 'volumetricFire']) {
  test(`${example} automatically discovers moving scene meshes without recompiling rigid transforms`,
    { timeout: 90000 }, async () => {
      const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
      await site.demo.watcher.close();
      let browser;
      try {
        browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
        await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
          + `?example=${example}&scene=movingColliders`, errors);
        const result = await page.evaluate(async root => {
          const { system, flip: gas, renderer, scene, camera, sceneLifecycle } = window.debugFluid;
          const { ThreeCollisionBackend } = await import(`/@fs${root}/packages/rzmps/build/index.mjs`);
          const { ParticleSystemSerializer } = await import(
            `/@fs${root}/apps/demo/src/gui/particle-system-gui/ParticleSystemSerializer.js`);
          const ordinary = new ThreeCollisionBackend({ world: scene });
          await system.prepare(renderer);
          const step = async () => {
            sceneLifecycle.update(1 / 60);
            ordinary.update(1 / 60);
            system.advanceFrames(1, 1 / 60);
            await renderer.renderAsync(scene, camera);
            await renderer.backend.device.queue.onSubmittedWorkDone();
          };
          for (let i = 0; i < 10; i++) await step();
          // Hold numerical quality fixed while testing transforms, not quality changes.
          gas.spatialGrid.autoVolumeQuality = false;
          const selected = [...gas.collectedColliders.keys()];
          const ordinaryMeshes = [...ordinary.trackedObjects.values()].map(entry => entry.object);
          const before = selected.map(mesh => mesh.matrixWorld.clone());
          let pipelines = 0;
          const create = renderer.backend.device.createComputePipeline;
          renderer.backend.device.createComputePipeline = function (...args) {
            pipelines++; return create.apply(this, args);
          };
          for (let i = 0; i < 50; i++) await step();
          const changed = selected.filter((mesh, index) => !mesh.matrixWorld.equals(before[index]));
          const mirrored = selected.every(mesh => ordinaryMeshes.includes(mesh));
          const currentMatrices = [...gas.collectedColliders].every(([mesh, entry]) =>
            mesh.matrixWorld.equals(entry.collider.matrix));
          const velocities = new Float32Array(await renderer.getArrayBufferAsync(gas.velocityCurrent.value));
          const finite = velocities.every(Number.isFinite);
          const exported = new ParticleSystemSerializer({ system }).serializeParticleSystem();
          renderer.backend.device.createComputePipeline = create;
          ordinary.dispose?.();
          return { discovered: selected.map(mesh => mesh.name), changed: changed.length,
            mirrored, currentMatrices, finite, pipelines,
            dynamicBrightnessExported: exported.includes('4 * (1 - time) ** 2') };
        }, path.resolve('.'));
        await fs.writeFile(`/tmp/moving-colliders-${example}.json`, JSON.stringify({ result, errors }, null, 2));
        await page.screenshot({ path: `/tmp/moving-colliders-${example}.png` });
        assert.deepEqual(errors, []);
        assert.equal(result.discovered.length, 5);
        assert.equal(result.changed, 4);
        assert(result.mirrored && result.currentMatrices && result.finite);
        if (example === 'volumetricFire') assert(result.dynamicBrightnessExported);
      } finally { await browser?.close(); await site.close(); }
    });
}
