import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('off-grid FLIP markers near walls stay stationary or in vertical freefall', { timeout: 180000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true,
      args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
    const measurements = [];
    for (const gravity of [0, -5.2]) {
      for (const pressureIterations of [0, 28]) {
        await page.goto(`${origin}/@fs${fixture}`, { waitUntil: 'networkidle0' });
        await page.waitForFunction(() => window.ready);
        await page.evaluate(() => window.runFrames(2));
        const result = await page.evaluate(async ({ gravity, pressureIterations }) => {
          window.seedFLIPPair(0, [0.085, 0.085]);
          const { system, flip } = window.debugFluid;
          system.gravity.set(0, gravity, 0);
          flip.pressureIterations = pressureIterations;
          flip.picRatio = 0.08;
          flip.particleSpacing = 1.1;
          const starts = [[0.13, -1.17, 1.9], [-0.17, -1.23, -1.7]];
          starts.forEach((position, slot) => window.moveParticle(position, [0, 0, 0], slot, 1));
          const probes = [];
          for (const start of starts) {
            const end = [...start];
            end[1] += gravity * (30 * 31 / 2) / 3600;
            const worldPoint = point => {
              const m = system.matrixWorld.elements;
              return [0, 1, 2].map(axis => m[axis] * point[0] + m[axis + 4] * point[1]
                + m[axis + 8] * point[2] + m[axis + 12]);
            };
            probes.push(await window.probe(worldPoint(start), worldPoint(end), 0.0425));
          }
          await window.runFrames(30);
          const particles = (await system.selectiveReadback(16000, ['position', 'velocity']))
            .filter(({ particle }) => particle.alive)
            .map(({ particle }) => ({ position: particle.position.toArray(), velocity: particle.velocity.toArray() }));
          return { gpu: system.isGPUProcessingActive, starts, probes, particles };
        }, { gravity, pressureIterations });
        measurements.push({ gravity, pressureIterations, ...result });
      }
    }
    console.log('FLIP wall drift:', JSON.stringify(measurements));
    for (const { gravity, pressureIterations, gpu, starts, probes, particles } of measurements) {
      const label = `gravity=${gravity}, pressure=${pressureIterations}`;
      assert.equal(gpu, true, label);
      assert.equal(particles.length, 2, label);
      probes.forEach(probe => assert.equal(probe[3], 0, `${label}: vertical path must be collision-free`));
      particles.forEach(({ position, velocity }, slot) => {
        for (const axis of [0, 2]) {
          assert.ok(Math.abs(position[axis] - starts[slot][axis]) < 0.005,
            `${label}, slot=${slot}: lateral position drift ${JSON.stringify(position)}`);
          assert.ok(Math.abs(velocity[axis]) < 0.02,
            `${label}, slot=${slot}: lateral velocity ${JSON.stringify(velocity)}`);
        }
        assert.ok(Math.abs(velocity[1] - gravity * 0.5) < 0.03,
          `${label}, slot=${slot}: vertical velocity ${velocity[1]}`);
        const expectedY = starts[slot][1] + gravity * (30 * 31 / 2) / 3600;
        assert.ok(Math.abs(position[1] - expectedY) < 0.01,
          `${label}, slot=${slot}: vertical position ${position[1]}, expected ${expectedY}`);
      });
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await site.close();
  }
});
