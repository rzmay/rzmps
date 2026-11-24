import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../scripts/site/dev.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('GPU grouped lights preserve a stable priority-selected registered source', { timeout: 60000 }, async () => {
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
      const { Particle, LightRenderer, createGPUParticleBufferState } = await import(url);
      const { system, renderer, scene, camera, THREE } = window.debugBehavior;
      await renderer.renderAsync(scene, camera);
      const sources = [1, 3].map(age => system.registerEmissionSource({ transform: new THREE.Matrix4(),
        age, lifetime: 4, metadata: { age } }));
      const particles = sources.map((source, index) => {
        const p = new Particle({ lifetime: 10 }); p.lodPriority = index ? 0.1 : 0.8;
        system.bindParticleSource(p, source); return p;
      });
      const buffers = createGPUParticleBufferState(particles, 4);
      const original = system.gpuSimulation._gpuBuffers;
      system.gpuSimulation._gpuBuffers = buffers;
      const selected = [];
      const lights = new LightRenderer({ count: 1, configureLight(particle, light) {
        selected.push(particle.source?.id); light.intensity = particle.source?.age ?? 0;
      } });
      lights.setup(system);
      for (let frame = 0; frame < 3; frame++) {
        lights.updateGPU(buffers, system, 1 / 60);
        while (lights._gpuReadbackPending) await new Promise(resolve => requestAnimationFrame(resolve));
      }
      const stable = selected.every(id => id === sources[1].id);
      sources[1].update({ age: 2 });
      lights.updateGPU(buffers, system, 1 / 60);
      while (lights._gpuReadbackPending) await new Promise(resolve => requestAnimationFrame(resolve));
      const age = lights.lights[0].intensity;
      particles[0].lodPriority = 0.01; buffers.upload(particles);
      lights.updateGPU(buffers, system, 1 / 60);
      while (lights._gpuReadbackPending) await new Promise(resolve => requestAnimationFrame(resolve));
      const changed = selected.at(-1) === sources[0].id;
      lights.destroy(); system.gpuSimulation._gpuBuffers = original; buffers.dispose();
      return { stable, changed, age, count: selected.length };
    }, `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`);
    assert(result.stable && result.changed, JSON.stringify(result));
    assert.equal(result.age, 2);
    assert.equal(result.count, 5);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await site.close(); }
});
