import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

// Frozen-state A/B: the old two-texture export + sparse sampler versus three-texture export + filtered velocity.
const output = process.argv[2] ?? '/tmp/rzmps-volume-velocity';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { headless: true, args: [...browserLaunchOptions('diagnostic').args, '--enable-unsafe-webgpu'] }));
  const results = [];
  for (const example of ['volumetricFire', 'volumetricSmoke']) {
    const page = await browser.newPage(), errors = [];
    await page.evaluateOnNewDocument(() => {
      let seed = 173;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const base = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
    await openFixture(page, `${base}/@fs${fixture}?example=${example}&scene=checkerboard&profile=true`, errors,
      { timeout: 30000 });
    const result = await page.evaluate(async ({ root, fullScene }) => {
      const { createSparseFieldSampler } = await import(
        `/@fs${root}/packages/rzmps/src/spatial/structures/gpu/sparseVolumeSampling.utils.ts`);
      const { textureStore } = await import(`/@fs${root}/apps/demo/tests/fluids/fixtures/fluid.js`);
      const { passTimer } = await import(`/@fs${root}/benchmarks/lib/passTimer.js`);
      const { renderer, scene, camera, system, flip: gas, THREE } = window.debugFluid;
      const volume = system.renderers.find(item => item.constructor.name === 'VolumeRenderer');
      for (let i = 0; i < 60; i++) {
        system.advanceFrames(1, 1 / 60);
        await renderer.resolveTimestampsAsync('compute');
      }
      // Isolate the volume path by default: fire's refraction sprites add unrelated framebuffer copies.
      if (!fullScene) for (const child of system.subSystems.keys()) child.visible = false;
      volume.dynamicResolution = false; volume.downsample = 1;
      const field = gas.getVolumeField(), textureSampler = field.sampleVelocityGPU;
      const sparseSampler = createSparseFieldSampler(gas.volumeGrid, gas.velocityCurrentAttribute);
      const write = gas.writeVolumeTextures, fullClear = gas.clearTexturesNode;
      let referenceClear, referenceOutput, referenceVisual;
      try {
        gas.writeVolumeTextures = function (coordinate, parameters, color) {
          textureStore(this.densityTextureNode, coordinate, parameters).toWriteOnly();
          textureStore(this.colorTextureNode, coordinate, color).toWriteOnly();
        };
        gas.clearTexturesNode = undefined;
        gas.clearOutputTextures(renderer); referenceClear = gas.clearTexturesNode;
        referenceOutput = gas.createOutputNode(gas.densityCurrent, gas.colorCurrent);
        referenceVisual = gas.createVisualOutputNode(gas.densityCurrent, gas.colorCurrent);
        // Build while the reference writer is active: TSL graph callbacks are lazy.
        renderer.compute(referenceOutput); renderer.compute(referenceVisual);
      } finally { gas.writeVolumeTextures = write; gas.clearTexturesNode = fullClear; }
      const outputNode = gas.createOutputNode(gas.densityCurrent, gas.colorCurrent);
      const visualNode = gas.createVisualOutputNode(gas.densityCurrent, gas.colorCurrent);
      const stretch = volume.densityNoiseStretch;
      const outside = camera.position.clone(), target = camera.getWorldDirection(new THREE.Vector3()).add(outside);
      volume.update([], system, 0); volume.mesh.updateWorldMatrix(true, false);
      const timings = [], images = [];
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
      const context = canvas.getContext('2d');
      let stage = 'export';
      const timer = passTimer(renderer.backend.device, renderer.backend, () => stage);
      const median = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
      };

      try {
        for (const view of ['outside', 'inside']) {
          if (view === 'outside') { camera.position.copy(outside); camera.lookAt(target); }
          else {
            camera.position.copy(volume.mesh.localToWorld(new THREE.Vector3()));
            camera.lookAt(volume.mesh.localToWorld(new THREE.Vector3(0, 0, -0.5)));
          }
          for (const mode of ['sparseBuffer', 'velocityTexture']) {
            volume.densityNoiseStretch = 0; volume.update([], system, 0);
            await renderer.renderAsync(scene, camera);
            field.sampleVelocityGPU = mode === 'sparseBuffer'
              ? position => sparseSampler.sample(position) : textureSampler;
            volume.densityNoiseStretch = stretch; volume.update([], system, 0);
            let image;
            const frame = async (measuring = false, capture = false) => {
              if (measuring) timer.start();
              stage = 'export';
              if (mode === 'sparseBuffer') {
                renderer.compute(referenceClear); renderer.compute(referenceOutput); renderer.compute(referenceVisual);
              } else {
                gas.clearOutputTextures(renderer); renderer.compute(outputNode); renderer.compute(visualNode);
              }
              stage = 'render';
              await renderer.renderAsync(scene, camera);
              // Copy before timestamp readback can yield past canvas presentation.
              if (capture) {
                image = renderer.domElement.toDataURL();
              }
              if (measuring) {
                const capture = await timer.finish();
                const exportMs = capture.stageGPUms.export ?? 0;
                return { exportMs, renderMs: capture.totalGPUms - exportMs, combinedMs: capture.totalGPUms,
                  passCounts: capture.passCounts,
                  exportPasses: capture.passes.filter(pass => pass.stage === 'export').length };
              }
              await renderer.backend.device.queue.onSubmittedWorkDone();
              await renderer.resolveTimestampsAsync('compute'); await renderer.resolveTimestampsAsync('render');
            };
            for (let i = 0; i < 20; i++) await frame();
            const samples = [];
            for (let i = 0; i < 24; i++) samples.push(await frame(true, i === 23));
            timings.push({ view, mode, samples,
              median: Object.fromEntries(['exportMs', 'renderMs', 'combinedMs']
                .map(key => [key, median(samples.map(sample => sample[key]))])) });
            images.push({ view, mode, image });
          }
        }
      } finally {
        timer.dispose(); field.sampleVelocityGPU = textureSampler; volume.densityNoiseStretch = stretch;
      }
      // Decode the immutable PNG captures; GPU-canvas drawImage/getImageData can race presentation.
      const decode = async data => {
        const bitmap = await createImageBitmap(await (await fetch(data)).blob());
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0); bitmap.close();
        return context.getImageData(0, 0, 800, 600).data;
      };
      for (const view of ['outside', 'inside']) {
        const reference = await decode(images.find(item => item.view === view && item.mode === 'sparseBuffer').image);
        const pixels = await decode(images.find(item => item.view === view && item.mode === 'velocityTexture').image);
        let error = 0;
        for (let i = 0; i < pixels.length; i++) error += Math.abs(pixels[i] - reference[i]);
        const result = timings.find(item => item.view === view && item.mode === 'velocityTexture');
        result.meanImageError = error / pixels.length;
      }
      const backing = gas.textureDimensions.toArray(), texels = backing.reduce((a, b) => a * b, 1);
      return { stretch, fullScene, dimensions: gas.gridDimensions.toArray(), cellSize: gas.cellSize, backing,
        extraTextureBytes: texels * 8, totalTextureBytes: texels * 24,
        residentPages: gas.brickDiagnostics.resident, timings, images,
        note: 'Fresh per-pass timestamps, one clear + simulation export + visual export, then render. '
          + 'Frozen state; excludes source gathering/solver.' };
    }, { root: path.resolve('.'), fullScene: process.argv.includes('--full-scene') });
    for (const { view, mode, image } of result.images) {
      await fs.writeFile(path.join(output, `${example}-${view}-${mode}.png`),
        Buffer.from(image.split(',')[1], 'base64'));
    }
    delete result.images;
    results.push({ example, result, errors });
    await page.close();
  }
  await fs.writeFile(path.join(output, 'timings.json'), JSON.stringify(results, null, 2));
  if (results.some(result => result.errors.length)) throw new Error(JSON.stringify(results));
  console.log(`Velocity sampling/export A/B saved to ${output}`);
} finally { await browser?.close(); await site.close(); }
