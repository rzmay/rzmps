import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('frozen heat laser attributes scene rendering and grouped-light count scaling',
  { timeout: 120000 }, async () => {
    const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
      server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
    let browser;
    try {
      await server.listen(); await server.watcher.close();
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await openFixture(page, `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/heatLaser.html`,
        errors, { timeout: 15000 });
      const result = await page.evaluate(async timerURL => {
        const { passTimer } = await import(timerURL);
        const { renderer, system, scene, camera, lifecycle, tsl } = window.laser;
        renderer.setRenderTarget(null); renderer.setSize(1280, 800);
        camera.aspect = 1280 / 800; camera.updateProjectionMatrix();
        lifecycle.gui({ addFolder() { return this; }, add(object, key) {
          if (key === 'automaticMotion') object[key] = true;
          return { onChange(callback) { if (key === 'automaticMotion') callback(); } };
        } });
        for (let frame = 0; frame < 360; frame++) {
          await new Promise(requestAnimationFrame);
          lifecycle.update(1 / 60); system.advanceFrames(1, 1 / 60);
          await renderer.renderAsync(scene, camera);
        }
        await renderer.backend.device.queue.onSubmittedWorkDone();

        // Freeze one physical state. Each exclusion changes only draw visibility, never simulation quality/state.
        const children = [...system.subSystems.keys()];
        const gasSystem = children.find(child => child.name === 'Laser Fire and Smoke');
        const volume = gasSystem.renderers.find(view => view.lightingGrid);
        const lights = gasSystem.renderers.find(view => view.lights);
        // Never let timing observations alter the A/B screen resolution. Full quality in every variant.
        volume.dynamicResolution = false;
        volume.dynamicTarget.configure(volume.downsample, false);
        const owners = [system, ...children], groups = {
          volume: [volume.mesh],
          lights: lights.lights,
          decals: [...new Set([system.userData.heatLaser.burns, system.userData.heatLaser.scorches]
            .flatMap(view => view.decals.map(decal => decal.mesh)))],
          trails: system.renderers.filter(view => view.ribbonCount !== undefined).map(view => view.mesh),
          ordinary: scene.userData.wallAndSphere.receivers,
        };
        let stage = 'frozen render';
        const timer = passTimer(renderer.backend.device, renderer.backend, () => stage);
        const cases = [], lightCases = [];
        const snapshot = () => ({ particles: gasSystem.liveParticleCount, pages: system.userData.heatLaser.gas
          .brickDiagnostics.resident, cellWidth: system.userData.heatLaser.gas.cellSize,
          densityVersion: system.userData.heatLaser.gas.getVolumeField().version,
          decals: system.userData.heatLaser.burns.count, steps: volume.steps, samplesPerVoxel: volume.samplesPerVoxel,
          scale: volume.dynamicTarget.resolutionScale, lights: lights.lights.length });
        const state = snapshot();
        const emptyInterval = volume.emptyInterval;
        const sampleVolume = volume.sampleVolume;
        const variants = ['none', ...Object.keys(groups), 'none-repeat'];
        if (emptyInterval) variants.push('occupancy-reference', 'occupancy-cached-repeat',
          'occupancy-cached-repeat', 'occupancy-reference');
        for (const excluded of variants) {
          const retainedMaterial = volume.webgpuMaterial;
          if (excluded === 'occupancy-reference') {
            // Same frozen fields and lattice, but force the old per-stratum occupancy check.
            volume.emptyInterval = function (...args) {
              const interval = emptyInterval.apply(this, args);
              return tsl.vec4(interval.x, 0, 0, 0).xy;
            };
            volume.sampleVolume = function (position, includeColor) {
              return sampleVolume.call(this, position, includeColor);
            };
            volume.webgpuMaterial = volume.createWebGPUMaterial();
          }
          const nodes = groups[excluded] ?? [], visibility = nodes.map(node => node.visible);
          nodes.forEach(node => { node.visible = false; });
          for (let frame = 0; frame < 12; frame++) {
            await new Promise(requestAnimationFrame);
            if (frame >= 4) timer.start();
            stage = `render/${excluded}`;
            await renderer.renderAsync(scene, camera);
            if (frame >= 4) cases.push({ excluded, gpu: await timer.finish() });
          }
          nodes.forEach((node, index) => { node.visible = visibility[index]; });
          if (excluded === 'occupancy-reference') {
            volume.webgpuMaterial.dispose();
            volume.webgpuMaterial = retainedMaterial;
            volume.emptyInterval = emptyInterval;
            volume.sampleVolume = sampleVolume;
          }
        }
        const frozenAfter = snapshot();

        // Independently measure the real grouping/selection/readback submission for the same particle bank.
        const originalCount = lights.count;
        for (const count of [1, 2, 4, 8, 16]) {
          lights.count = count;
          const pipelines = window.laser.pipelineBuilds();
          for (let frame = 0; frame < 16; frame++) {
            await new Promise(requestAnimationFrame);
            if (frame >= 8) timer.start();
            stage = `grouping/${count}`;
            const started = performance.now();
            lights.updateGPU(gasSystem.gpuParticleBuffers, gasSystem, 0);
            const cpuMs = performance.now() - started;
            await renderer.renderAsync(scene, camera);
            if (frame >= 8) lightCases.push({ count, cpuMs, gpu: await timer.finish(),
              active: lights.lights.filter(light => light.intensity > 0).length });
          }
          lightCases.push({ count, pipelines: window.laser.pipelineBuilds() - pipelines });
        }
        lights.count = originalCount;
        timer.dispose();
        return { state, frozenAfter, cases, lightCases, errors: window.laser.errors,
          rendererCount: owners.reduce((sum, owner) => sum + owner.renderers.length, 0) };
      }, `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`);
      await writeFile(process.env.RZMPS_HEAT_LASER_ATTRIBUTION ?? '/tmp/heat-laser-render-attribution.json',
        JSON.stringify(result, null, 2));
      const median = list => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
      console.log('Frozen render:', JSON.stringify(Object.fromEntries([...new Set(result.cases.map(row => row.excluded))]
        .map(name => [name, median(result.cases.filter(row => row.excluded === name).map(row => row.gpu.totalGPUms))]))));
      console.log('Grouping:', JSON.stringify([1, 2, 4, 8, 16].map(count => ({ count,
        computeMs: median(result.lightCases.filter(row => row.count === count && row.gpu)
          .map(row => row.gpu.stageGPUms[`grouping/${count}`] ?? 0)) }))));
      assert.deepEqual(result.state, result.frozenAfter, 'A/Bs preserve physical state and render sampling quality');
      assert.deepEqual(errors, []); assert.deepEqual(result.errors, []);
    } finally { await browser?.close(); await server.close(); }
  });
