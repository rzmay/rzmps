import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

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
    + '?example=volumetricSmoke', errors);
  const result = await page.evaluate(async () => {
    const { system, flip, THREE } = window.debugFluid;
    const born = await window.runFrames(1);
    const first = await window.runFrames(29);
    const risen = await window.runFrames(60);
    const rate = system.emitters[0].rate;
    system.emitters[0].rate = 0;
    const fading = await window.runFrames(120);
    return { born, firstCount: first.count, first: first.field, risen: risen.field, fading: fading.field,
      count: fading.count, maxBounds: flip.spatialGridOptions.maxBounds, weight: flip.weight,
      domain: flip.bounds.getSize(new THREE.Vector3()).toArray(),
      children: system.renderers[0].renderedChildCount,
      rate, buoyancy: flip.buoyancy, sourceLifetime: system.emitters[0].initialValues.lifetime,
      dissipation: flip.densityDissipation, diffusion: flip.scalarDiffusion,
      turbulence: flip.turbulenceNoiseStrength, color: system.emitters[0].initialValues.color.getHexString(),
      temperatureTint: system.renderers[0].colorByTemperature };
  });
  assert.equal(result.maxBounds, 16);
  assert.equal(result.weight, 0.03);
  assert.equal(result.rate, 300);
  assert.equal(result.buoyancy, 1.8);
  assert.equal(result.sourceLifetime, 1.2);
  assert.equal(result.dissipation, 0.9);
  assert.equal(result.children, 0);
  assert.equal(result.diffusion, 0.35);
  assert.equal(result.turbulence, 2);
  assert.equal(result.color, 'a59d9d');
  assert.equal(result.temperatureTint, null);
  assert(result.first.sum > 0 && result.risen.sum > 0);
  assert(result.risen.centroidY > result.first.centroidY + 0.05, 'continuous smoke rises');
  assert(result.fading.sum < result.risen.sum, 'detached smoke fades when the source is stopped');
  assert(result.domain.every(side => side <= 16));
  assert.equal(result.count, 0, 'source particles die while gas remains');
  const catalog = await page.evaluate(async () => {
    const { examples } = await import('/@fs' + window.location.pathname.split('/@fs')[1]
      .split('/scripts/')[0] + '/examples/index.js');
    const entry = examples.find(item => item.id === 'volumetricFire');
    const fire = await entry.create();
    const distortion = [...fire.subSystems.keys()][0];
    const summary = { cap: fire.modules[0].spatialGridOptions.maxBounds, brightness: fire.renderers[1].brightness,
      distortion: !!distortion, transmission: distortion.renderers[0].materialOptions.transmission,
      softParticleDistance: distortion.renderers[0].softParticleDistance,
      autoShrink: fire.modules[0].spatialGridOptions.autoShrink,
      backend: entry.previewSettings.backend, source: entry.sourceUrl,
      liquid: examples.filter(item => item.id === 'flipFluid').map(item => ({
        id: item.id, backend: item.previewSettings.backend, source: item.sourceUrl })),
      removed: examples.some(item => ['gasVolume', 'steamBurst'].includes(item.id)) };
    fire.destroy();
    return summary;
  });
  assert.equal(catalog.cap, 16);
  assert.equal(catalog.brightness, 4);
  assert.equal(catalog.distortion, true);
  assert.equal(catalog.transmission, 1);
  assert.equal(catalog.softParticleDistance, 0);
  assert.equal(catalog.autoShrink, true);
  assert.equal(catalog.backend, 'webgpu');
  assert(catalog.source.endsWith('/examples/presets/volumetricFire.js'));
  assert.deepEqual(catalog.liquid, [{ id: 'flipFluid', backend: 'webgpu',
    source: 'https://github.com/rzmay/rzmps/blob/develop/examples/presets/flipFluid.js' }]);
  assert.equal(catalog.removed, false);
  // Exercise preparation on the demo's multisampled path, then keep drawing the live flame.
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?example=volumetricFire&antialias&measureStartup&prepareStartup', errors);
  const fire = await page.evaluate(async () => {
    const { system, renderer, scene, camera, flip, THREE } = window.debugFluid;
    // Read the provider's actual render texture, independently of its simulation buffers.
    // A narrow vertical slab covers the flame without transferring the entire 3D texture.
    const readRenderedDensity = async () => {
      const device = renderer.backend.device;
      const texture = renderer.backend.get(flip.getVolumeField().texture).texture;
      if (texture.format !== 'rgba16float') throw new Error(`Unexpected gas texture format: ${texture.format}`);
      const width = Math.min(16, texture.width), height = texture.height;
      const depth = Math.min(16, texture.depthOrArrayLayers);
      const bytesPerRow = Math.ceil(width * 8 / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height * depth,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, origin: {
          x: Math.floor((texture.width - width) / 2), y: 0,
          z: Math.floor((texture.depthOrArrayLayers - depth) / 2),
        } }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height, depthOrArrayLayers: depth });
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const data = new Uint16Array(buffer.getMappedRange());
        let sum = 0;
        for (let z = 0; z < depth; z++) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          sum += THREE.DataUtils.fromHalfFloat(data[(z * height + y) * bytesPerRow / 2 + x * 4]);
        }
        return sum;
      } finally { buffer.destroy(); }
    };
    const initialDomain = flip.bounds.getSize(new THREE.Vector3()).toArray();
    for (let frame = 0; frame < 180; frame++) {
      system.advanceFrames(1, 1 / 60);
      await renderer.renderAsync(scene, camera);
      // Bounds observations are asynchronous and wall-clock throttled in the interactive demo too.
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const flowing = await window.runFrames(1);
    const renderedBefore = await readRenderedDensity();
    const later = await window.runFrames(60);
    const renderedAfter = await readRenderedDensity();
    return { initialDomain, domain: flip.bounds.getSize(new THREE.Vector3()).toArray(),
      flowing: flowing.field, later: later.field, renderedBefore, renderedAfter,
      startup: window.fluidStartup.firstPopulatedFrameMs };
  });
  assert.deepEqual(fire.initialDomain, [4, 4, 4]);
  assert(fire.domain.every(side => side > 4 && side <= 16));
  assert.equal(fire.later.nonfinite, 0);
  assert(fire.flowing.sum > 0 && fire.later.sum > 0);
  assert(Math.abs(fire.later.sum - fire.flowing.sum) > 1e-3, 'gas keeps evolving after domain growth');
  assert(Number.isFinite(fire.renderedBefore) && fire.renderedBefore > 0);
  assert(Number.isFinite(fire.renderedAfter) && fire.renderedAfter > 0);
  assert(Math.abs(fire.renderedAfter - fire.renderedBefore) > 1e-3, 'the rendered field updates after domain growth');
  const integrity = await page.evaluate(() => window.checkGridBoundsAndCycle());
  assert.deepEqual(integrity.bounds, [4, 4, 4]);
  assert.equal(integrity.visits, integrity.capacity, 'cyclic traversal stops at the exact structural bound');
  assert.equal(integrity.nearest, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ centroidY: [result.first.centroidY, result.risen.centroidY, result.fading.centroidY],
    remainingDensity: result.fading.sum, domain: result.domain, children: result.children, catalog, fire, integrity }));
} finally { await browser?.close(); await site.close(); }
