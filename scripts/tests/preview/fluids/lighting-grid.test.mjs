import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('directional cascades support dynamic lights, probes, environments, attenuation and shared volumes',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width: 400, height: 300 });
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/lighting-grid.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      const checks = await page.evaluate(() => window.testLighting());
      const output = '/tmp/rzmps-lighting-grid'; await fs.mkdir(output, { recursive: true });
      const measurements = [];
      for (const count of [1, 8, 32, 64]) {
        measurements.push(await page.evaluate(
          count => window.measureLighting({ levels: 3, directions: 6, count }), count));
      }
      for (const [name, levels, directions, cellSize] of
        [['low', 2, 4, 0.5], ['medium', 3, 6, 0.25], ['high', 4, 12, 0.125]]) {
        measurements.push({ name, ...await page.evaluate(config => window.measureLighting(config),
          { levels, directions, cellSize, count: 8 }) });
        await page.screenshot({ path: `${output}/${name}.png` });
      }
      await fs.writeFile(`${output}/results.json`, JSON.stringify({ checks, measurements, errors }, null, 2));
      assert.deepEqual(errors, []);
      for (const result of measurements) {
        assert(result.statistics.probes > 0 && result.statistics.memoryBytes > 0);
        assert(result.updateGPUms.every(Number.isFinite) && result.raymarchGPUms.every(Number.isFinite));
      }
      const fireFixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fireFixture}`
        + '?example=volumetricFire', errors, { timeout: 20000 });
      const fire = await page.evaluate(async () => {
        const { system, renderer, scene, camera, flip: gas } = window.debugFluid;
        await window.runFrames(3); system.pause();
        const version = gas.getVolumeField().version;
        const volume = system.renderers.find(renderer => renderer.constructor.name === 'VolumeRenderer');
        volume.lightingGridOptions = { levels: 2, directions: 4 }; system.updateRenderers(false);
        const grid = volume.lightingGrid;
        await renderer.renderAsync(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        const result = { unchanged: gas.getVolumeField().version === version, ...grid.statistics };
        volume.lightingGridOptions = undefined; system.updateRenderers(false);
        return result;
      });
      assert(fire.unchanged && fire.updates > 0 && fire.lights > 0,
        'real fire fields and render callbacks integrate without advancing the paused simulation');
      assert.deepEqual(errors, []);
      console.log(`Lighting quality images and GPU timings: ${output}`);
    } finally {
      await browser?.close(); await site.close();
    }
  });
