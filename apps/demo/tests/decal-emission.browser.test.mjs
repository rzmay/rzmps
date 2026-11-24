import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../scripts/site/dev.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('moving registered sources preserve GPU birth locations and per-batch age stamps',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      await openFixture(page, `${origin}/@fs${path.resolve(import.meta.dirname, 'fluids/fixtures/corrective.html')}`,
        errors);
      const result = await page.evaluate(async url => {
        const { ParticleSystem, Emitter, EmissionShape } = await import(url);
        const { renderer, scene, camera, THREE } = window.debugBehavior;
        const parent = new ParticleSystem({ gpuProcessing: false, gravityModifier: 0, emitters: [], renderers: [] });
        const shape = EmissionShape.Sphere(0.01);
        shape.getPoint = () => ({ position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) });
        const child = new ParticleSystem({ gpuProcessing: true, gravityModifier: 0, maxParticles: 128,
          emitters: new Emitter({ source: shape, sourceTags: ['probe'], rate: 60, radialSpeed: 0,
            initialValues: { lifetime: 10, color: 'white', velocity: new THREE.Vector3() } }), renderers: [] });
        parent.addSubSystem(child, { emitContinuous: true, inheritLifetime: 0, inheritScale: 0,
          inheritColor: 1, inheritVelocity: 0, shouldEmit: source => source.alpha > 0 });
        scene.add(parent);
        await renderer.renderAsync(scene, camera); await parent.prepare(renderer);
        const sources = [-1, 1].map(sign => parent.registerEmissionSource({ tags: ['probe'],
          transform: new THREE.Matrix4().makeTranslation(sign * 4, 0, 0), age: 0, lifetime: 10 }));
        let maxPositionError = 0, maxAgeError = 0, count = 0;
        for (let frame = 0; frame < 12; frame++) {
          sources.forEach((source, i) => {
            const x = (i ? 1 : -1) * (4 + frame * 0.2);
            source.update({ transform: new THREE.Matrix4().makeTranslation(x, 0, 0), age: frame / 60,
              color: new THREE.Color((x + 8) / 16, (frame + 1) / 64, 1) });
          });
          parent.advanceFrames(1, 1 / 60);
          const particles = await child.selectiveReadback();
          count = Math.max(count, particles.length);
          for (const { valid, particle } of particles) {
            if (!valid) continue;
            const expectedX = particle.color.r * 16 - 8;
            const bornFrame = Math.round(particle.color.g * 64) - 1;
            maxPositionError = Math.max(maxPositionError, Math.abs(particle.position.x - expectedX));
            maxAgeError = Math.max(maxAgeError, Math.abs(particle.realtime / 1000 - (frame - bornFrame) / 60));
          }
        }
        const gpu = child.isGPUProcessingActive;
        const settings = ParticleSystem.Settings;
        const readbackRate = settings.GPU_READBACK_RATE;
        let lateSource;
        try {
          // GPU deaths must free capacity even when no full CPU mirror readback is requested.
          settings.GPU_READBACK_RATE = 0;
          child.emitters[0].initialValues.lifetime = 0.05;
          for (let frame = 0; frame < 100; frame++) {
            await new Promise(requestAnimationFrame);
            if (frame === 80) lateSource = parent.registerEmissionSource({ tags: ['probe'],
              transform: new THREE.Matrix4().makeTranslation(20, 0, 0), lifetime: 10 });
            parent.advanceFrames(1, 1 / 60);
            await renderer.renderAsync(scene, camera);
          }
          const live = await child.selectiveReadback();
          const lateEmits = live.some(({ valid, particle }) => valid && Math.abs(particle.position.x - 20) < 1e-5);
          return { maxPositionError, maxAgeError, count, gpu, lateEmits, hasLateSource: !!lateSource };
        } finally {
          settings.GPU_READBACK_RATE = readbackRate;
          parent.destroy();
        }
      }, `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`);
      assert(result.gpu && result.count > 10, JSON.stringify(result));
      assert(result.lateEmits && result.hasLateSource, 'new sources must reuse GPU-dead slots without CPU readback');
      assert(result.maxPositionError < 1e-5, JSON.stringify(result));
      assert(result.maxAgeError < 1 / 60 + 1e-5, JSON.stringify(result));
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
