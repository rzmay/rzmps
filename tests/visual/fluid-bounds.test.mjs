import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('fluid cap policies preserve adaptive escape, constrain crossings, and close gas flux', { timeout: 240000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true,
      args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
    const open = async (example) => {
      await page.goto(`${origin}/@fs${fixture}?example=${example}&fixedGas=true`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready);
      await page.evaluate(() => window.runFrames(2));
    };
    const results = [];
    for (const example of ['flipFluid', 'gasVolume']) {
      for (const policy of ['Ballistic', 'Kill', 'Contain']) {
        await open(example);
        const result = await page.evaluate(async ({ example, policy }) => {
          const { system, flip, renderer } = window.debugFluid;
          if (example === 'gasVolume') window.seedGasSource(1, 0);
          else { window.seedFLIPPair(); flip.particleSeparation = 0; }
          system.gravity.set(0, 0, 0);
          flip.externalForce.set(0, 0, 0);
          flip.automaticPadding = false;
          flip.boundsPolicy = policy;
          system.modules.filter(module => module.constructor.name === 'TransformByNoise')
            .forEach(module => { module.options.strength = 0; });
          window.capDeaths = 0;
          system.onDeath(() => { window.capDeaths++; });
          const count = example === 'gasVolume' ? 1 : 2;
          for (let slot = 0; slot < count; slot++) window.moveParticle([7.9, 1, slot], [4, 0, 1], slot, 1);
          await window.runFrames(1, 0.1);
          const particles = (await system.selectiveReadback(16000, ['position', 'velocity']))
            .filter(({ particle }) => particle.alive)
            .map(({ particle }) => ({ position: particle.position.toArray(), velocity: particle.velocity.toArray() }));
          await renderer.backend.device.queue.onSubmittedWorkDone();
          await new Promise(resolve => setTimeout(resolve, 80));
          await window.runFrames(1, 0.01);
          await new Promise(resolve => setTimeout(resolve, 80));
          return { example, policy, count, particles, deaths: window.capDeaths };
        }, { example, policy });
        results.push(result);
        if (policy === 'Kill') {
          assert.equal(result.particles.length, 0);
          assert.equal(result.deaths, result.count, 'cap deaths must be reported exactly once');
        } else {
          assert.equal(result.particles.length, result.count);
          for (const p of result.particles) {
            if (policy === 'Ballistic') assert.ok(p.position[0] > 8);
            else {
              assert.ok(p.position[0] < 8 && p.position[0] > 7.7);
              assert.equal(p.velocity[0], 0);
              assert.ok(Math.abs(p.velocity[2] - 1) < 1e-5, 'containment must preserve tangential motion');
            }
          }
        }
      }
      await open(example);
      const intermediate = await page.evaluate(async (example) => {
        const { system, flip } = window.debugFluid;
        if (example === 'gasVolume') window.seedGasSource(1, 0);
        else { window.seedFLIPPair(); flip.particleSeparation = 0; }
        flip.boundsPolicy = 'Contain';
        flip.maxBounds = 32;
        flip.automaticPadding = false;
        const edge = flip.bounds.max.x;
        system.gravity.set(0, 0, 0);
        flip.externalForce.set(0, 0, 0);
        window.moveParticle([edge - 0.1, 1, 0], [4, 0, 0], 0, 1);
        await window.runFrames(1, 0.1);
        return { edge, positions: await window.readLivePositions(), closed: flip.closedMaxNode.value.toArray() };
      }, example);
      assert.ok(intermediate.positions.some(p => p[0] > intermediate.edge), 'an intermediate grid edge must stay open');
      assert.deepEqual(intermediate.closed, [0, 0, 0]);
    }

    await open('gasVolume');
    await page.evaluate(() => window.seedUniformGas());
    const closed = await page.evaluate(async () => {
      window.debugFluid.flip.boundsPolicy = 'Contain';
      const result = await window.runFrames(30);
      return { result, flux: await window.gasCapFlux() };
    });
    assert.ok(Math.abs(closed.result.field.peak - 0.5) < 1e-5);
    assert.ok(Math.abs(closed.result.field.sum / (64 ** 3 * 0.5) - 1) < 1e-5,
      'closed cap faces must not absorb uniform gas');
    assert.equal(closed.flux, 0, 'closed pressure faces must have zero normal flow');
    console.log('Cap policies:', JSON.stringify(results));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await site.close();
  }
});
