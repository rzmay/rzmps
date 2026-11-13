import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-volume-sampling';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
const results = {};
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  for (const backend of ['webgl', 'webgpu']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
    const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?backend=${backend}`;
    await openFixture(page, url, errors);
    const validation = await page.evaluate(async () => {
      const { volume, red, scene, THREE, renderer, camera, system } = window.volumeFixture;
      red.color = undefined;
      red.density.data.fill(0.5); red.density.version++;
      Object.assign(volume, { color: new THREE.Color('white'), opacity: 0.5,
        densityMapping: 'Linear', minDensity: 0, maxDensity: 1, transmittanceThreshold: 0,
        adaptiveStepping: false, sceneDepthClipping: false, dynamicResolution: false });
      const light = new THREE.DirectionalLight('white', 0.1);
      scene.add(light); light.position.z = -5;
      volume.light = light;
      const opacity = [];
      for (const samplesPerVoxel of [1, 2, 4]) for (const jitterStrength of [0, 1]) {
        for (const steps of [1, 64]) {
          Object.assign(volume, { samplesPerVoxel, jitterStrength, steps, anisotropy: 0 });
          opacity.push((await window.renderVolume(['red'])).middle);
        }
      }
      const lighting = {};
      for (const anisotropy of [-0.5, 0, 0.5]) {
        volume.anisotropy = anisotropy;
        lighting[anisotropy] = (await window.renderVolume(['red'])).middle;
      }
      const forward = lighting[0.5];
      light.position.z = 5;
      const reverseForward = (await window.renderVolume(['red'])).middle;
      volume.anisotropy = -0.5;
      const reverseBackward = (await window.renderVolume(['red'])).middle;
      volume.anisotropy = 0;
      const reverseIsotropic = (await window.renderVolume(['red'])).middle;
      volume.jitterStrength = 1;
      const stable = await window.renderVolume(['red']);
      const repeated = await window.renderVolume(['red']);
      volume.shadowQuality = 2;
      const shadowed = (await window.renderVolume(['red'])).middle;
      // Compare linear render targets: canvas pipelines blend/encode transparency differently
      // between Three's WebGL and WebGPU renderers, independently of the volume equations.
      const target = new THREE.WebGLRenderTarget(480, 320);
      renderer.setRenderTarget(target);
      volume.depthTest = false;
      volume.shadowQuality = 0;
      light.position.z = -5;
      const linearLighting = {};
      for (const anisotropy of [-0.5, 0, 0.5]) {
        volume.anisotropy = anisotropy;
        volume.update([], system, 0);
        if (renderer.isWebGPURenderer) await renderer.renderAsync(scene, camera);
        else renderer.render(scene, camera);
        const pixel = renderer.isWebGPURenderer
          ? await renderer.readRenderTargetPixelsAsync(target, 240, 160, 1, 1)
          : await renderer.readRenderTargetPixelsAsync(target, 240, 160, 1, 1, new Uint8Array(4));
        linearLighting[anisotropy] = [...pixel];
      }
      renderer.setRenderTarget(null); target.dispose();
      // Physical parameter ramps compose on the renderer, independently of their provider.
      const originalField = red.density;
      const data = new Float32Array(8 ** 3 * 4);
      red.density = { ...originalField, data, channels: 4,
        resolution: new THREE.Vector3(8, 8, 8),
        parameterChannels: { temperature: 1, speed: 2, vorticity: 3 } };
      const setHeat = heat => {
        for (let i = 0; i < data.length; i += 4) data.set([0.5, heat, 0.5, 0.5], i);
        red.density.version++;
      };
      Object.assign(volume, { anisotropy: 0, shadowQuality: 0, opacity: 0.5,
        colorByTemperature: [new THREE.Color('blue'), new THREE.Color('red')] });
      setHeat(0);
      const cool = (await window.renderVolume(['red'])).middle;
      setHeat(1);
      const hot = (await window.renderVolume(['red'])).middle;
      volume.colorBySpeed = new THREE.Color(0, 1, 0);
      const multiplied = (await window.renderVolume(['red'])).middle;
      volume.colorBySpeed = undefined;
      volume.opacityByTemperature = [1, 0];
      const invisible = (await window.renderVolume(['red'])).middle;
      Object.assign(volume, { colorByTemperature: undefined, opacityByTemperature: undefined });
      red.density = originalField;
      // Remapping endpoints and density-driven color use the same normalized interval.
      Object.assign(volume, { minDensity: 0.2, maxDensity: 0.8,
        colorByDensity: [new THREE.Color('blue'), new THREE.Color('red')] });
      const remapping = [];
      for (const density of [0.1, 0.2, 0.5, 0.8, 1]) {
        red.density.data.fill(density); red.density.version++;
        remapping.push((await window.renderVolume(['red'])).middle);
      }
      Object.assign(volume, { minDensity: 0, maxDensity: 1, colorByDensity: null });
      return { opacity, lighting, linearLighting, forward, reverseForward, reverseBackward, reverseIsotropic,
        stable, repeated, shadowed, remapping, appearance: { cool, hot, multiplied, invisible } };
    });
    assert(validation.remapping[0].slice(0, 3).every(v => v === 0), 'density below minimum is transparent');
    assert(validation.remapping[1].slice(0, 3).every(v => v === 0), 'minimum density maps to zero');
    assert.deepEqual(validation.remapping[3], validation.remapping[4], 'density saturates at maximum');
    assert(validation.remapping[3][0] > validation.remapping[3][2], 'maximum density selects red ramp endpoint');
    assert(validation.appearance.cool[2] > validation.appearance.cool[0], 'cool gas uses blue renderer ramp');
    assert(validation.appearance.hot[0] > validation.appearance.hot[2], 'hot gas uses red renderer ramp');
    assert(validation.appearance.multiplied.slice(0, 3).every(channel => channel === 0),
      'temperature and speed color controls multiply');
    assert(validation.appearance.invisible.slice(0, 3).every(channel => channel === 0),
      'temperature controls optical opacity');
    for (const pixel of validation.opacity) {
      assert(Math.abs(pixel[0] - validation.opacity[0][0]) <= 2, 'constant-density opacity is sampling invariant');
    }
    assert(validation.forward[0] > validation.lighting[-0.5][0] + 10, 'positive g favors forward scattering');
    assert(validation.reverseBackward[0] > validation.reverseForward[0] + 10, 'negative g favors back scattering');
    assert(Math.abs(validation.reverseIsotropic[0] - validation.lighting[0][0]) <= 2, 'g=0 is symmetric');
    assert.deepEqual(validation.stable, validation.repeated, 'static volume jitter must not depend on frame');
    assert(validation.shadowed[0] < validation.reverseIsotropic[0], 'self shadows attenuate the directional term');
    await page.screenshot({ path: path.join(output, `${backend}-shadows.png`) });
    results[backend] = { validation };
    if (backend === 'webgpu') {
      results[backend].benchmark = await page.evaluate(async () => {
        const { volume, red, renderer, scene, camera, system } = window.volumeFixture;
        const n = 32;
        red.density.resolution.set(n, n, n);
        red.density.data = Float32Array.from({ length: n ** 3 }, (_, i) => {
          const x = (i % n + 0.5) / n - 0.5;
          const y = (Math.floor(i / n) % n + 0.5) / n - 0.5;
          const z = (Math.floor(i / (n * n)) + 0.5) / n - 0.5;
          return Math.max(0, 1 - Math.hypot(x, y, z) * 2.2);
        });
        red.density.version++;
        Object.assign(volume, { steps: 96, samplesPerVoxel: 2, jitterStrength: 1,
          densityNoiseStrength: 0, opacity: 0.7, depthTest: false });
        renderer.backend.trackTimestamp = renderer.backend.device.features.has('timestamp-query');
        // Measure the union of real render-pass intervals. Summing Three's resumed/output
        // context durations can double count; the result must stay distinct from wall time.
        const device = renderer.backend.device;
        const supported = device.features.has('timestamp-query');
        const createEncoder = device.createCommandEncoder.bind(device);
        const queries = supported ? device.createQuerySet({ type: 'timestamp', count: 128 }) : null;
        const resolveBuffer = supported ? device.createBuffer({ size: 1024,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
        const readBuffer = supported ? device.createBuffer({ size: 1024,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }) : null;
        let queryCount = 0;
        if (supported) device.createCommandEncoder = (...args) => {
          const encoder = createEncoder(...args);
          const begin = encoder.beginRenderPass.bind(encoder);
          encoder.beginRenderPass = descriptor => {
            const index = queryCount; queryCount += 2;
            return begin({ ...descriptor, timestampWrites: { querySet: queries,
              beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1 } });
          };
          return encoder;
        };
        const resolveGPU = async () => {
          if (!supported || !queryCount) return null;
          const count = queryCount; queryCount = 0;
          const encoder = createEncoder();
          encoder.resolveQuerySet(queries, 0, count, resolveBuffer, 0);
          encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, count * 8);
          device.queue.submit([encoder.finish()]);
          await readBuffer.mapAsync(GPUMapMode.READ, 0, count * 8);
          const times = new BigUint64Array(readBuffer.getMappedRange(0, count * 8));
          let first = times[0], last = times[1];
          for (let i = 0; i < count; i += 2) {
            if (times[i] < first) first = times[i];
            if (times[i + 1] > last) last = times[i + 1];
          }
          const elapsed = Number(last - first) / 1e6;
          readBuffer.unmap();
          return elapsed;
        };
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const rows = [];
        for (const [interpolation, profile, withColor, densityNoiseStrength, shadowQuality] of [
          ...['Linear', 'Cubic'].flatMap(mode => [
            [mode, 'density', false, 0, 0],
            [mode, 'density + color', true, 0, 0],
            [mode, 'density + noise', false, 2, 0],
            [mode, 'density + shadows', false, 0, 2],
            [mode, 'density + color + shadows', true, 0, 2],
          ]),
        ]) {
          red.color = withColor ? { ...red.density, channels: 4,
            data: new Float32Array(n ** 3 * 4).fill(1), version: 0 } : undefined;
          Object.assign(volume, { interpolation, anisotropy: 0.5, shadowQuality, densityNoiseStrength });
          volume.tags = ['red'];
          volume.update([], system, 0);
          for (let i = 0; i < 2; i++) {
            await renderer.renderAsync(scene, camera);
            await resolveGPU();
          }
          const wall = [], gpu = [];
          for (let i = 0; i < 4; i++) {
            const start = performance.now();
            await renderer.renderAsync(scene, camera);
            await renderer.backend.device.queue.onSubmittedWorkDone();
            wall.push(performance.now() - start);
            const elapsed = await resolveGPU();
            if (elapsed !== null) gpu.push(elapsed);
          }
          rows.push({ interpolation, profile, shadowQuality, samplesPerVoxel: 2, maximumSteps: 96,
            jitterStrength: 1, densityNoiseStrength, resolution: n, primaryCenterRaySamples: 64,
            estimatedDensityFieldEvaluations: 64 * (1 + (shadowQuality ? 16 : 0)),
            estimatedColorFieldEvaluations: withColor ? 64 : 0,
            estimatedTextureLookups: 64 * (1 + (withColor ? 1 : 0) + (shadowQuality ? 16 : 0))
              * (interpolation === 'Cubic' ? 8 : 1),
            shadowSamplesPerPrimaryLimit: shadowQuality ? 16 : 0,
            textureEvaluationsPerDensitySample: interpolation === 'Cubic' ? 8 : 1,
            gpuMs: gpu.length ? median(gpu) : null, fencedWallMs: median(wall) });
        }
        device.createCommandEncoder = createEncoder;
        queries?.destroy(); resolveBuffer?.destroy(); readBuffer?.destroy();
        return rows;
      });
      results[backend].skipEquivalence = await page.evaluate(async () => {
        const { volume, renderer } = window.volumeFixture;
        const capture = () => {
          const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
          const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
          return context.getImageData(0, 0, 480, 320).data;
        };
        const cases = [];
        for (const densityNoiseStrength of [0, 2]) {
          Object.assign(volume, { interpolation: 'Linear', shadowQuality: 0, anisotropy: 0,
            densityNoiseStrength, densityNoiseContrast: 1.5, samplesPerVoxel: 1, steps: 128, jitterStrength: 1,
            emptySpaceSkipping: false });
          await window.renderVolume(['red']); const reference = capture();
          volume.emptySpaceSkipping = true;
          await window.renderVolume(['red']); const skipped = capture();
          let maximumDifference = 0, changed = 0;
          for (let i = 0; i < reference.length; i++) {
            const delta = Math.abs(reference[i] - skipped[i]);
            maximumDifference = Math.max(maximumDifference, delta); if (delta > 2) changed++;
          }
          cases.push({ densityNoiseStrength, maximumDifference, changed,
            skippingActive: volume.layers.every(layer => !!layer.density.occupancy) });
        }
        return cases;
      });
      for (const result of results[backend].skipEquivalence) {
        assert(result.skippingActive, 'the regression must exercise native occupancy traversal');
        assert(result.maximumDifference <= 2,
          `empty-space skipping changes the sampling lattice: ${JSON.stringify(result)}`);
      }
      // Bounded oblique-camera captures make banding/jitter comparison reviewable on a frozen field.
      for (const samplesPerVoxel of [1, 2, 4]) for (const jitterStrength of [0, 1]) {
        const stable = await page.evaluate(async ({ samplesPerVoxel, jitterStrength }) => {
          const { camera, volume } = window.volumeFixture;
          camera.position.set(3, 3, 4); camera.lookAt(-0.5, 0, 0);
          Object.assign(volume, { interpolation: 'Linear', shadowQuality: 0, anisotropy: 0,
            samplesPerVoxel, jitterStrength });
          const first = await window.renderVolume(['red']);
          const second = await window.renderVolume(['red']);
          return JSON.stringify(first) === JSON.stringify(second);
        }, { samplesPerVoxel, jitterStrength });
        assert(stable, 'nonuniform frozen volume remains stable without temporal jitter');
        const capture = path.join(output, `oblique-${samplesPerVoxel}-${jitterStrength}.png`);
        await page.screenshot({ path: capture });
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
  // The two shader implementations may choose different jitter values through floating-point sin,
  // but constant-density optical integration and directional response must agree.
  for (const g of [-0.5, 0, 0.5]) {
    const difference = results.webgl.validation.linearLighting[g][0] - results.webgpu.validation.linearLighting[g][0];
    assert(Math.abs(difference) <= 3);
  }
  console.log(JSON.stringify(results));
} finally {
  await browser?.close();
  await site.close();
}
