import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('fluid runtime changes and bounded gas transport preserve numerical invariants', { timeout: 180000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true,
      args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
    const open = async (example = 'gasBlenderSmoke') => {
      await page.goto(`${origin}/@fs${fixture}?example=${example}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready).catch(error => {
        throw new Error(`${error.message}\n${errors.join('\n')}`);
      });
      await page.evaluate(() => window.runFrames(30));
    };
    await open();
    assert.ok(await page.evaluate(() => window.projectGas(1)) > 0.001);
    assert.equal(await page.evaluate(() => window.projectGas(0)), 0,
      'disabling pressure must not apply an old odd-parity pressure buffer');
    assert.ok(await page.evaluate(() => window.projectGas(4)) > 0.001);
    assert.equal(await page.evaluate(() => window.projectGas(0)), 0);
    await page.evaluate(() => window.projectGas(16, 'waves'));
    const projection = await page.evaluate(() => window.lastProjectionMetrics.faces);
    assert.ok(projection.after < projection.before * 0.6, 'pressure must reduce actual transport divergence');
    assert.ok(projection.residualError < 1e-4, 'projected divergence must equal the discrete Poisson residual');
    console.log('Gas face projection:', JSON.stringify(projection));

    const translated = {};
    for (const method of ['semiLagrangian', 'macCormack']) {
      await open();
      await page.evaluate(method => {
        window.seedGas('gaussian');
        const gas = window.debugFluid.flip;
        gas.advectionMethod = method;
        gas.vorticityStrength = 0;
      }, method);
      const initial = await page.evaluate(() => window.runFrames(0));
      const after = await page.evaluate(() => {
        window.gaussianTime = 2;
        return window.runFrames(120);
      });
      assert.equal(after.field.negative, 0);
      assert.equal(after.field.nonfinite, 0);
      assert.ok(after.field.peak <= initial.field.peak + 1e-5, 'bounded advection cannot create a new maximum');
      assert.ok(after.field.maxColorError < 1e-5, 'constant source color must travel with density');
      assert.ok(after.field.maxTemperatureError < 1e-5, 'specific temperature must travel with density');
      translated[method] = after.field;
    }
    assert.ok(translated.macCormack.gaussianError < translated.semiLagrangian.gaussianError * 0.7,
      'higher-order transport must reduce error, not merely increase motion');
    console.log('Translated Gaussian:', JSON.stringify(translated));

    await open();
    await page.evaluate(() => {
      window.seedGas('mixed');
      window.debugFluid.flip.advectionMethod = 'macCormack';
      window.debugFluid.flip.vorticityStrength = 0;
    });
    const mixed = await page.evaluate(() => window.runFrames(120));
    assert.ok(mixed.field.minTemperature >= 0);
    assert.ok(mixed.field.maxTemperature <= 1.00001, 'mixed source temperatures cannot overshoot after dividing heat by density');
    assert.ok(mixed.field.maxColor <= 1.00001, 'density-weighted colors must stay within donor color bounds');

    for (const method of ['semiLagrangian', 'macCormack']) {
      await open();
      await page.evaluate(method => {
        window.addGasWall();
        window.seedGas('wall');
        window.debugFluid.flip.advectionMethod = method;
        window.debugFluid.flip.vorticityStrength = 0;
      }, method);
      await page.evaluate(() => window.runFrames(120));
      const wall = await page.evaluate(() => window.gasWallMetrics());
      assert.ok(wall.solidCells > 0, 'the actual FluidCollider must occupy grid cells');
      assert.equal(wall.occupiedDensity, 0);
      assert.ok(wall.leaked < 1e-5, `${method}: gas must not cross an occupied slab`);
      await page.evaluate(() => window.projectGas(16, 'waves'));
      const wallProjection = await page.evaluate(() => window.lastProjectionMetrics.faces);
      assert.equal(wallProjection.blockedFlux, 0, 'pressure cannot introduce normal flow through solid faces');
      assert.ok(wallProjection.residualError < 1e-4, 'solid boundary stencils must match the pressure operator');
    }

    await open('gasVolume');
    await page.evaluate(() => {
      const { flip, system } = window.debugFluid;
      flip.maxBounds = 32;
      flip.automaticPadding = true;
      const grid = flip.getParticleSpatialGrid(system);
      grid.setOptions({ autoExpand: true });
      window.moveParticle([30, 0, 0]);
      flip.lastBoundsRead = -Infinity;
    });
    await page.evaluate(() => window.runFrames(1));
    await new Promise(resolve => setTimeout(resolve, 100));
    const pending = await page.evaluate(async () => {
      const { flip, system, renderer } = window.debugFluid;
      const grid = flip.getParticleSpatialGrid(system);
      const bounds = await grid.readBounds(renderer);
      return { matches: bounds.equals(flip.bounds), autoExpand: grid.autoExpand };
    });
    assert.equal(pending.matches, true, 'readback completion must not mutate the live domain between updates');
    assert.equal(pending.autoExpand, false, 'the GPU hash must not resize ahead of the solver');
    await page.evaluate(() => window.runFrames(1));
    const applied = await page.evaluate(async () => {
      const { flip, system, renderer } = window.debugFluid;
      const bounds = await flip.getParticleSpatialGrid(system).readBounds(renderer);
      return { matches: bounds.equals(flip.bounds), side: bounds.max.x - bounds.min.x };
    });
    assert.equal(applied.matches, true);
    assert.equal(applied.side, 32);
    await page.evaluate(() => {
      const gas = window.debugFluid.flip;
      gas.advectionMethod = 'semiLagrangian';
      gas.setSpatialGridOptions({ brickSubdivisions: 2, cellSubdivisions: 3 });
    });
    await page.evaluate(() => window.runFrames(2));
    await page.evaluate(() => { window.debugFluid.flip.advectionMethod = 'macCormack'; });
    const rebuilt = await page.evaluate(() => window.runFrames(2));
    assert.equal(await page.evaluate(() => window.debugFluid.flip.resolution), 32);
    assert.equal(rebuilt.field.nonfinite, 0, 'quality rebuilds and method changes must discard obsolete cached passes');

    await open('gasVolume');
    const plume = [];
    for (let interval = 0; interval < 6; interval++) {
      const stats = await page.evaluate(() => window.runFrames(600));
      assert.equal(stats.field.negative, 0);
      assert.equal(stats.field.nonfinite, 0);
      assert.ok(stats.field.maxTemperature <= 1.0001, 'the continuous plume cannot manufacture hotter source temperatures');
      assert.ok(stats.field.peak < 100, 'the default plume must not develop extreme density spikes');
      plume.push({ seconds: (interval + 1) * 10, ...stats.field });
    }
    console.log('Continuous gas through 60 seconds:', JSON.stringify(plume));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await site.close();
  }
});
