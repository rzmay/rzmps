import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../scripts/site/dev.mjs';
import { openFixture } from './fluids/openFixture.mjs';

test('GPU noise modes preserve velocity behavior and apply position/force without extra integration',
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
      const values = await page.evaluate(async url => {
        const { TransformByNoise, TransformMode, Particle, createGPUParticleBufferState } = await import(url);
        const { renderer, system, THREE, StorageBufferAttribute, tsl } = window.debugBehavior;
        const { Fn, float, uint, vec4, storage } = tsl;
        const particle = new Particle({ lifetime: 10, mass: 2, position: new THREE.Vector3(1, 2, 3) });
        const buffers = createGPUParticleBufferState([particle]);
        const output = new StorageBufferAttribute(new Float32Array(44), 4), target = storage(output, 'vec4', 11);
        const node = Fn(() => {
          [TransformMode.Position, TransformMode.Velocity, TransformMode.Force].forEach((mode, index) => {
            const view = buffers.storage.createParticle(uint(0), true);
            const module = new TransformByNoise({ transformMode: mode, strength: 2, frequency: 1.5 });
            module.modifyGPU(view, float(0.25), { system, buffers, elapsedTimeNode: float(1) });
            target.element(index * 3).assign(vec4(view.position, 0));
            target.element(index * 3 + 1).assign(vec4(view.velocity, 0));
            target.element(index * 3 + 2).assign(vec4(view.acceleration, 0));
          });
          [0, 1].forEach((seconds, index) => {
            const view = buffers.storage.createParticle(uint(0), true);
            const module = new TransformByNoise({ transformMode: TransformMode.Position, strength: 2, scrollSpeed: 3 });
            module.modifyGPU(view, float(0.25), { system, buffers, elapsedTimeNode: float(seconds) });
            target.element(9 + index).assign(vec4(view.position, 0));
          });
        })().compute(1);
        renderer.compute(node);
        const values = [...new Float32Array(await renderer.getArrayBufferAsync(output))];
        node.dispose(); output.dispose(); buffers.dispose();
        return values;
      }, `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`);
      assert(values.every(Number.isFinite));
      const offset = values.slice(0, 3).map((value, i) => value - [1, 2, 3][i]);
      assert(offset.some(value => Math.abs(value) > 0.001));
      for (let i = 0; i < 3; i++) {
        assert(Math.abs(values[16 + i] - offset[i] * 0.25) < 1e-5);
        assert(Math.abs(values[32 + i] - offset[i] / 2) < 1e-5);
        assert.equal(values[4 + i], 0);
        assert.equal(values[28 + i], 0);
      }
      assert(values.slice(36, 39).some((value, i) => Math.abs(value - values[40 + i]) > 0.01),
        'GPU noise must evolve at a fixed position as simulation time advances');
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
