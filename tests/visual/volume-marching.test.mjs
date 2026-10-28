import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('adaptive ray lengths preserve opacity and clip opaque depth with perspective/orthographic views',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
      for (const backend of ['webgl', 'webgpu', 'webgpu&reversed=true']) {
        await page.goto(`${origin}/@fs${fixture}?backend=${backend}`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.ready);
        const result = await page.evaluate(async () => {
          const { red, volume, system, renderer, scene, camera, THREE } = window.volumeFixture;
          Object.assign(volume, { generateChildren: false, densityMapping: 'Linear', densityRange: [0, 1],
            opacity: 0.3, transmittanceThreshold: 0, stepSizeMultiplier: 0.1, jitter: false });
          red.density.data.fill(1);
          red.density.bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
          red.density.version++;
          const pixel = async (view = camera) => {
            volume.tags = ['red'];
            volume.update([], system, 0);
            if (renderer.isWebGPURenderer) await renderer.renderAsync(scene, view);
            else renderer.render(scene, view);
            const canvas = document.createElement('canvas');
            canvas.width = 480; canvas.height = 320;
            const context = canvas.getContext('2d');
            context.drawImage(renderer.domElement, 0, 0);
            return context.getImageData(240, 160, 1, 1).data[0];
          };
          const variants = [];
          for (const steps of [4, 17, 160]) for (const factor of [1, 4, 12]) {
            Object.assign(volume, { steps, adaptiveStepping: factor > 1,
              adaptiveStepThreshold: 0.1, adaptiveStepFactor: factor });
            variants.push({ steps, factor, red: await pixel() });
          }
          if (!renderer.isWebGPURenderer) return { variants };
          Object.assign(volume, { steps: 160, adaptiveStepping: true, sceneDepthClipping: true, sceneDepthBias: 0 });
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0 }));
          scene.add(plane);
          const depth = {};
          for (const z of [2, 0, -2]) { plane.position.z = z; depth[z] = await pixel(); }
          plane.visible = false;
          volume.opacity = 1 - Math.sqrt(1 - 0.3);
          const halfReference = await pixel();
          volume.opacity = 0.3;
          const fullReference = await pixel();
          const ortho = new THREE.OrthographicCamera(-2, 2, 1.4, -1.4, 0.1, 30);
          ortho.position.z = 6;
          plane.visible = true;
          plane.position.z = 0;
          const orthographicHalf = await pixel(ortho);
          plane.position.z = 2;
          const orthographicHidden = await pixel(ortho);
          plane.visible = false;
          camera.position.z = 0;
          camera.near = 0.1;
          camera.updateProjectionMatrix();
          const inside = await pixel();
          plane.position.z = -0.5;
          plane.visible = true;
          const insideClipped = await pixel();
          camera.position.set(5, 4, 6);
          camera.lookAt(0, 0, 0);
          const oblique = await pixel();
          plane.position.z = 2;
          const obliqueHidden = await pixel();
          return { variants, depth, halfReference, fullReference, orthographicHalf, orthographicHidden,
            inside, insideClipped, oblique, obliqueHidden };
        });
        console.log(backend, 'marching', JSON.stringify(result));
        const reference = result.variants[0].red;
        assert.ok(reference > 50, 'uniform volume must be visible');
        for (const variant of result.variants) assert.ok(Math.abs(variant.red - reference) <= 2,
          `sample distance must not change uniform opacity: ${JSON.stringify(variant)}`);
        if (backend.startsWith('webgpu')) {
          assert.equal(result.depth[2], 0, 'foreground opaque plane must hide the volume');
          assert.ok(Math.abs(result.depth[0] - result.halfReference) <= 2,
            'interior plane clips exactly half the path');
          assert.ok(Math.abs(result.depth[-2] - result.fullReference) <= 2, 'background geometry preserves full fog');
          assert.ok(Math.abs(result.orthographicHalf - result.halfReference) <= 2, 'orthographic depth uses view Z');
          assert.equal(result.orthographicHidden, 0);
          assert.ok(result.insideClipped > 0 && result.insideClipped < result.inside,
            'camera-inside rays clip correctly');
          assert.ok(result.oblique > 0 && result.obliqueHidden === 0, 'oblique views preserve depth occlusion');
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await site.close();
    }
  });
