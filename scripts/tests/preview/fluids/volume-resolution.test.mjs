import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  for (const reversed of [false, true]) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
      + `?backend=webgpu${reversed ? '&reversed' : ''}`, errors);
    const result = await page.evaluate(async () => {
      const { volume, red, system, renderer, scene, camera, THREE } = window.volumeFixture;
      // Compute-bound frames cannot be helped by dropping screen resolution.
      const controller = volume.dynamicTarget;
      controller.configure(1, true);
      const timingOnlyRenderer = {
        backend: { device: { features: { has: () => true } } },
        info: { render: { timestamp: 2 }, compute: { timestamp: 1000 } },
        resolveTimestampsAsync: async () => {},
      };
      for (let batch = 0; batch < 24; batch++) {
        for (let frame = 0; frame < 8; frame++) {
          controller.render(timingOnlyRenderer, scene, camera, volume.mesh, volume.webgpuMaterial, {});
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const computeBoundScale = controller.resolutionScale;
      controller.releaseTiming();
      red.color = undefined;
      Object.assign(volume, { color: new THREE.Color('white'), opacity: 0.5,
        densityMapping: 'Linear', minDensity: 0, maxDensity: 1, densityNoiseStrength: 0, jitterStrength: 0,
        dynamicResolution: false, transmittanceThreshold: 0 });
      const reference = (await window.renderVolume(['red'])).middle;
      volume.downsample = 2;
      // Multiple transparent entries expose render-list corruption when the nested opaque
      // depth pass accidentally uses the outer scene/camera cache identity.
      const markers = [-1, 1].map(x => {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false }));
        mesh.position.set(x, 1, -1);
        mesh.renderOrder = volume.mesh.renderOrder + 1;
        scene.add(mesh);
        return mesh;
      });
      const fixed = (await window.renderVolume(['red'])).middle;
      for (let frame = 0; frame < 3; frame++) await window.renderVolume(['red']);
      for (const mesh of markers) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      const fixedScale = volume.dynamicTarget.resolutionScale;
      volume.downsample = 1;
      volume.dynamicResolution = { minimumScale: 0.5 };
      for (let i = 0; i < 120; i++) volume.dynamicTarget.observe(100, volume.dynamicResolution);
      const reduced = (await window.renderVolume(['red'])).middle;
      const target = [...volume.dynamicTarget.targets.values()][0];
      const rawColor = [...await renderer.readRenderTargetPixelsAsync(target, 120, 80, 1, 1, 0)]
        .map(value => THREE.DataUtils.fromHalfFloat(value));
      const rawMetadata = [...await renderer.readRenderTargetPixelsAsync(target, 120, 80, 1, 1, 1)]
        .map(value => THREE.DataUtils.fromHalfFloat(value));
      // Opaque geometry covers only one side; low-resolution rays must not bleed over its silhouette.
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 0.1), new THREE.MeshBasicMaterial({ color: 'black' }));
      wall.position.set(0.5, 0, 1); scene.add(wall);
      const clipped = await window.renderVolume(['red']);
      camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1);
      const inside = (await window.renderVolume(['red'])).middle;
      const ortho = new THREE.OrthographicCamera(-2, 2, 1.33, -1.33, 0.1, 30);
      ortho.position.z = 6; ortho.lookAt(0, 0, 0);
      volume.update([], system, 0);
      await renderer.renderAsync(scene, ortho);
      // Copy the presented canvas immediately; a later GPU readback can yield past presentation.
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
      const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
      const orthographic = [...context.getImageData(240, 160, 1, 1).data];
      const orthoMetadata = [...await renderer.readRenderTargetPixelsAsync(target, 120, 80, 1, 1, 1)]
        .map(value => THREE.DataUtils.fromHalfFloat(value));
      const orthoColor = [...await renderer.readRenderTargetPixelsAsync(target, 120, 80, 1, 1, 0)]
        .map(value => THREE.DataUtils.fromHalfFloat(value));
      const scale = volume.dynamicTarget.resolutionScale;
      volume.dynamicResolution = false; volume.update([], system, 0);
      await renderer.renderAsync(scene, ortho); context.drawImage(renderer.domElement, 0, 0);
      const orthoReference = [...context.getImageData(240, 160, 1, 1).data];
      // The same inside/depth path must include transformed volume children.
      volume.generateChildren = true;
      volume.children = { count: [2, 2], radius: 0.1, scale: 0.8, alpha: 0.5 };
      volume.downsample = 2;
      camera.position.set(0, 0, 6); camera.lookAt(0, 0, 0);
      const childClipped = await window.renderVolume(['red']);
      camera.position.set(0, 0, 0); camera.lookAt(0, 0, -1);
      const childInside = (await window.renderVolume(['red'])).middle;
      return { computeBoundScale, reference, fixed, fixedScale, childClipped, childInside, reduced,
        rawColor, rawMetadata,
        clipped, inside, orthographic,
        orthoReference, orthoColor, orthoMetadata, scale,
        pooledTargets: volume.dynamicTarget.targets.size };
    });

    assert.equal(result.computeBoundScale, 1, 'simulation cost must not lower render resolution');
    assert.equal(result.fixedScale, 0.5);
    assert(Math.abs(result.reference[0] - result.fixed[0]) <= 3, 'manual downsampling preserves radiance');
    assert.equal(result.scale, 0.5);
    assert(result.reduced[0] > 0, 'reduced volume remains visible');
    assert(Math.abs(result.reference[0] - result.reduced[0]) <= 3, 'constant-density radiance is preserved');
    assert(result.clipped.right[0] <= 1, 'opaque geometry remains in front');
    assert(result.inside[0] > 0, 'camera-inside reconstruction remains visible');
    assert(result.childInside[0] > 0, 'camera-inside rendering includes volume children');
    assert(result.childClipped.right[0] <= 1, 'opaque geometry clips volume children');
    assert(result.orthographic[0] > 0, 'orthographic reconstruction remains visible');
    assert.equal(result.pooledTargets, 1, 'stable resolution reuses its target');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ reversed, ...result }));
    await page.close();
  }
} finally {
  await browser?.close(); await site.close();
}
