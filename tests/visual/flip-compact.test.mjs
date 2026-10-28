import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('compact liquid matches dense execution and invalidates cached solids on motion',
  { timeout: 240000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage();
      page.setDefaultTimeout(120000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const outcomes = [];
      for (const mode of ['compact', 'dense']) {
        await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
          path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`
          + `?reviewGrid=3,4&reviewLiquidWork=${mode}`);
        await page.waitForFunction(() => window.ready).catch(error => {
          throw new Error(`${error.message}\n${errors.join('\n')}`);
        });
        outcomes.push(await page.evaluate(async () => {
          const { system, flip, renderer, scene, gpu: { Fn, instanceIndex, vec4 } } = window.debugFluid;
          window.seedFLIPPair();
          flip.pressureIterations = 28;
          flip.picRatio = 0.08;
          flip.particleSpacing = 1.1;
          system.gravity.set(0, -5.2, 0);
          // A reproducible cloud crossing the three central brick planes.
          const buffers = system._gpuBuffers;
          renderer.compute(Fn(() => {
            const particle = buffers.storage.createParticle(undefined, true);
            particle.alive.assign(instanceIndex.lessThan(512).select(1, 0));
            particle.position.x.assign(instanceIndex.mod(8).toFloat().sub(3.5).mul(0.08));
            particle.position.y.assign(instanceIndex.div(8).mod(8).toFloat().sub(3.5).mul(0.08).add(0.05));
            particle.position.z.assign(instanceIndex.div(64).mod(8).toFloat().sub(3.5).mul(0.08));
            particle.velocity.assign(vec4(0.12, -0.2, -0.07, 0).xyz);
            particle.scale.assign(vec4(0.085).xyz);
            particle.mass.assign(1);
            particle.speed.assign(1);
            particle.lifetime.assign(60);
            particle.realtime.assign(0);
            particle.time.assign(0);
            buffers.storage.storeParticle(particle);
          })().compute(buffers.count));
          const snapshots = [];
          for (const frames of [1, 29, 5]) {
            if (snapshots.length === 2) {
              renderer.compute(Fn(() => {
                const particle = buffers.storage.createParticle(undefined, true);
                particle.position.x.addAssign(2);
                particle.position.z.addAssign(2);
                particle.velocity.assign(vec4(0).xyz);
                buffers.storage.storeParticle(particle);
              })().compute(buffers.count));
            }
            await window.runFrames(frames);
            snapshots.push((await system.selectiveReadback(16000, ['position', 'velocity']))
              .filter(({ particle }) => particle.alive)
              .flatMap(({ particle }) => [...particle.position.toArray(), ...particle.velocity.toArray()]));
          }
          const pressure = new Float32Array(await renderer.getArrayBufferAsync(flip.pressureCurrentAttribute));
          const n = flip.resolution;
          let retiredPressure = 0;
          for (let z = 56; z < 72; z++) for (let y = 56; y < 72; y++) for (let x = 56; x < 72; x++) {
            retiredPressure = Math.max(retiredPressure, Math.abs(pressure[x + n * (y + n * z)]));
          }
          const bricks = new Uint32Array(await renderer.getArrayBufferAsync(flip.workGrid.diagnosticsAttribute));
          let solidDispatches = 0;
          const compute = renderer.compute;
          renderer.compute = function (node, ...args) {
            if (node === flip.solidNode) solidDispatches++;
            return compute.call(this, node, ...args);
          };
          await window.runFrames(2);
          const stationary = solidDispatches;
          solidDispatches = 0;
          const pivot = scene.getObjectByName('Teapot Tip Pivot');
          pivot.rotation.z = -0.1;
          pivot.updateWorldMatrix(true, true);
          await window.runFrames(1);
          const moving = solidDispatches;
          solidDispatches = 0;
          await window.runFrames(1);
          const stopped = solidDispatches;
          renderer.compute = compute;
          return { snapshots, active: bricks[0], total: flip.workGrid.brickCount, retiredPressure,
            stationary, moving, stopped };
        }));
      }
      assert.deepEqual(errors, []);
      const [compact, dense] = outcomes;
      assert(compact.active > 0 && compact.active < compact.total / 2, 'compact work must omit empty bricks');
      for (let frame = 0; frame < compact.snapshots.length; frame++) {
        assert.equal(compact.snapshots[frame].length, 512 * 6);
        assert.equal(dense.snapshots[frame].length, compact.snapshots[frame].length);
        const error = Math.max(...compact.snapshots[frame].map((value, index) =>
          Math.abs(value - dense.snapshots[frame][index])));
        console.log(`Compact/dense marker error at snapshot ${frame}: ${error}`);
        assert(error < 1e-4, 'compaction must preserve particle motion, including shared faces');
      }
      assert.equal(compact.stationary, 0);
      assert.equal(compact.moving, 1);
      assert.equal(compact.stopped, 0);
      assert.equal(compact.retiredPressure, 0, 'retired bricks must not retain pressure');
      assert.equal(dense.stationary, 2, 'reference path must recompute solids');
      console.log('Active liquid bricks:', compact.active, '/', compact.total);
    } finally { await browser?.close(); await site.close(); }
  });
