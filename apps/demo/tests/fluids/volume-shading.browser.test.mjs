import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

for (const backend of ['webgl', 'webgpu']) {
  test(`${backend} volume HG phase and self-lit factors follow opposite-view scattering conventions`,
    { timeout: 90000 }, async () => {
      const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
      await site.demo.watcher.close();
      let browser;
      try {
        browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
        const base = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
        await openFixture(page, `${base}/@fs${fixture}?backend=${backend}`, errors);
        const result = await page.evaluate(async ({ gpu, root }) => {
          const { renderer, scene, camera, system, volume, THREE } = window.volumeFixture;
          const { GasModule } = await import(`/@fs${root}/packages/rzmps/build/index.mjs`);
          const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
          const field = { bounds, resolution: new THREE.Vector3(8, 8, 8), channels: 4,
            parameterChannels: { temperature: 1, speed: 2, vorticity: 3 },
            data: new Float32Array(8 ** 3 * 4), version: 0 };
          const colors = { ...field, data: new Float32Array(field.data.length) };
          for (let i = 0; i < field.data.length; i += 4) {
            field.data.set([0.8, 1, 0.5, 0], i); colors.data.set([1, 1, 1, 1], i);
          }
          Object.assign(volume, { field, colorField: colors, generateChildren: false, densityNoiseStrength: 0,
            color: new THREE.Color('white'), colorByTemperature: null, opacityByTemperature: null,
            opacity: 0.1, densityMapping: 'Linear', dynamicResolution: false, downsample: 1,
            jitter: false, steps: 128, samplesPerVoxel: 2, shadowQuality: 0, softParticles: false,
            emptySpaceSkipping: false, depthTest: false,
            lightingGridOptions: gpu ? { directions: 32, levels: 2, cellSize: 0.5, samplesPerInterval: 4,
              ambient: 'black', maxDistance: 8 } : undefined });
          const light = new THREE.DirectionalLight('white', 1); light.position.set(0, 0, 4);
          scene.children.filter(object => object.isLight).forEach(object => scene.remove(object));
          scene.add(light); volume.light = light;
          const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
          const context = canvas.getContext('2d');
          const capture = async (side = 1) => {
            camera.position.set(0, 0, side * 5); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
            volume.update([], system, 0);
            if (gpu) await renderer.renderAsync(scene, camera);
            else renderer.render(scene, camera);
            context.drawImage(renderer.domElement, 0, 0);
            const pixels = context.getImageData(238, 158, 5, 5).data;
            const rgb = [0, 0, 0];
            for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) rgb[i % 4] += pixels[i] / 25;
            return rgb;
          };
          const phase = [];
          for (const g of [-0.8, 0, 0.8]) {
            volume.anisotropy = g;
            const front = await capture(1), updates = volume.lightingGrid?.statistics.updates;
            window.phaseImages ??= [];
            window.phaseImages.push({ g, side: 'Light-facing view', image: renderer.domElement.toDataURL() });
            const back = await capture(-1);
            phase.push({ g, front, back, gridUpdates: volume.lightingGrid?.statistics.updates - updates });
            window.phaseImages.push({ g, side: 'Opposite-light view', image: renderer.domElement.toDataURL() });
          }
          volume.anisotropy = 0;
          volume.opacity = 0.6;
          light.color.set('blue');
          volume.emissive = 0;
          const lit = await capture();
          volume.emissive = 1;
          const self = await capture();
          volume.emissive = 8;
          const high = await capture();
          volume.emissive = -2;
          const low = await capture();
          volume.emissive = 1; volume.emissiveByTemperature = [0, 1];
          volume.emissiveByDensity = [0, 1]; volume.emissiveBySpeed = [0, 1];
          const combined = await capture();
          for (let i = 1; i < field.data.length; i += 4) field.data[i] = 0;
          field.version++;
          const cold = await capture();
          for (let i = 1; i < field.data.length; i += 4) field.data[i] = 1;
          field.version++;
          const controls = {};
          if (gpu) {
            volume.emissive = 0;
            volume.emissiveByTemperature = volume.emissiveByDensity = volume.emissiveBySpeed = null;
            const module = new GasModule({ modifyRenderGPU(_cell, context) { context.emissive.assign(1); } });
            system.addModule(module);
            controls.procedural = await capture();
            system.removeModule(module);
            volume.emissive = 8;
            const attenuate = new GasModule({ modifyRenderGPU(_cell, context) { context.emissive.mulAssign(0.5); } });
            system.addModule(attenuate);
            controls.proceduralEffective = await capture();
            system.removeModule(attenuate);

            // Keep the fields fixed and compare full images: the center ray alone can hide
            // coordinate stretching perpendicular to the view direction.
            const { uniform } = window.volumeFixture;
            const flow = uniform(new THREE.Vector3(2, 0, 0));
            let velocityReads = 0;
            field.sampleVelocityGPU = () => { velocityReads++; return flow; };
            Object.assign(volume, { emissive: 1, densityNoiseStrength: 2, densityNoiseFrequency: 2,
              densityNoiseContrast: 1, densityNoiseSpeed: 0, densityNoiseStretch: 0 });
            const image = async () => {
              await capture();
              return [...context.getImageData(120, 60, 240, 200).data];
            };
            const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
            const unstretched = await image();
            controls.disabledVelocityReads = velocityReads;
            volume.densityNoiseStretch = 0.6;
            const stretched = await image();
            controls.stretchDifference = difference(unstretched, stretched);
            controls.enabledVelocityReads = velocityReads;

            // Zero local stretch and missing/zero velocity must preserve the old mask exactly.
            volume.densityNoiseStretchByTemperature = [1, 0];
            controls.hotStretchDifference = difference(unstretched, await image());
            for (let i = 1; i < field.data.length; i += 4) field.data[i] = 0;
            field.version++;
            controls.coldStretchDifference = difference(unstretched, await image());
            volume.densityNoiseStretchByTemperature = null;
            volume.densityNoiseStretchByDensity = [0, 0];
            controls.zeroDensityModifierDifference = difference(unstretched, await image());
            volume.densityNoiseStretchByDensity = null;
            volume.densityNoiseStretchBySpeed = [0, 0];
            controls.zeroSpeedModifierDifference = difference(unstretched, await image());
            volume.densityNoiseStretchBySpeed = null;
            flow.value.set(0, 2, 0);
            controls.flowDirectionDifference = difference(stretched, await image());
            flow.value.set(0, 0, 0);
            controls.zeroVelocityDifference = difference(unstretched, await image());
            delete field.sampleVelocityGPU;
            controls.missingVelocityDifference = difference(unstretched, await image());
            controls.fieldsUnchanged = field.data.every((value, i) => value === [0.8, 0, 0.5, 0][i % 4]
              || Math.abs(value - [0.8, 0, 0.5, 0][i % 4]) < 1e-6);
          }
          return { phase, lit, self, high, low, combined, cold, ...controls };
        }, { gpu: backend === 'webgpu', root: path.resolve('.') });
        await fs.writeFile(`/tmp/volume-shading-${backend}.json`, JSON.stringify({ result, errors }, null, 2));
        const images = await page.evaluate(() => window.phaseImages);
        await page.evaluate(images => {
          const grid = document.createElement('div'); grid.id = 'phase-contact';
          grid.style.cssText = 'position:fixed;inset:0 auto auto 0;width:720px;background:#202020;'
            + 'color:white;display:grid;grid-template-columns:1fr 1fr;z-index:9999;font:14px sans-serif';
          for (const { g, side, image } of images) {
            const tile = document.createElement('div');
            const label = document.createElement('div'); label.textContent = `g = ${g} · ${side}`;
            const view = document.createElement('img'); view.src = image; view.style.width = '360px';
            tile.append(label, view); grid.append(tile);
          }
          document.body.append(grid);
        }, images);
        await page.$eval('#phase-contact', async grid => {
          await Promise.all([...grid.querySelectorAll('img')].map(image => image.decode()));
        });
        await (await page.$('#phase-contact')).screenshot({ path: `/tmp/volume-phase-${backend}.png` });
        assert.deepEqual(errors, []);
        const [negative, isotropic, positive] = result.phase;
        assert(negative.front[0] > negative.back[0] * 1.2, JSON.stringify(negative));
        assert(positive.back[0] > positive.front[0] * 1.2, JSON.stringify(positive));
        assert(Math.abs(isotropic.front[0] - isotropic.back[0]) < 12);
        if (backend === 'webgpu') assert(result.phase.every(row => row.gridUpdates === 0));
        assert(result.lit[2] > result.lit[0] * 1.4, JSON.stringify(result));
        assert(Math.abs(result.self[2] - result.self[0]) < 3);
        assert(result.high.every((value, i) => Math.abs(value - result.self[i]) < 2));
        assert(result.low.every((value, i) => Math.abs(value - result.lit[i]) < 2));
        assert(result.combined[0] > result.lit[0] && result.combined[0] < result.self[0]);
        assert(result.cold.every((value, i) => Math.abs(value - result.lit[i]) < 2));
        if (backend === 'webgpu') {
          assert(result.procedural.every((value, i) => Math.abs(value - result.self[i]) < 2));
          assert(result.proceduralEffective[0] > result.lit[0]
            && result.proceduralEffective[0] < result.self[0]);
          assert.equal(result.disabledVelocityReads, 0);
          assert(result.enabledVelocityReads > 0);
          assert(result.stretchDifference > 1, JSON.stringify(result));
          assert(result.coldStretchDifference > 1);
          assert(result.flowDirectionDifference > 1);
          assert(result.hotStretchDifference < 0.1);
          assert(result.zeroDensityModifierDifference < 0.1);
          assert(result.zeroSpeedModifierDifference < 0.1);
          assert(result.zeroVelocityDifference < 0.1);
          assert(result.missingVelocityDifference < 0.1);
          assert(result.fieldsUnchanged);
        }
      } finally { await browser?.close(); await site.close(); }
    });
}
