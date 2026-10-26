import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('gas source lifetime, alpha and source-particle collision bound grid injection', { timeout: 120000 }, async () => {
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
    const open = async (wall = false) => {
      await page.goto(`${origin}/@fs${fixture}?example=gasVolume&fixedGas=true${wall ? '&sourceWall' : ''}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready);
      await page.evaluate(() => window.runFrames(2));
    };
    const amounts = [];
    for (const [remaining, alpha, dt] of [[1, 1, 0.01], [0.01, 1, 0.5], [1, 0.5, 0.01]]) {
      await open();
      amounts.push(await page.evaluate(async ({ remaining, alpha, dt }) => {
        window.seedGasSource(remaining, alpha);
        return (await window.runFrames(1, dt)).field.sum;
      }, { remaining, alpha, dt }));
    }
    assert.ok(amounts[0] > 0);
    assert.ok(Math.abs(amounts[1] / amounts[0] - 1) < 1e-4,
      'a dying particle must emit only for its remaining lifetime, not the whole long update');
    assert.ok(Math.abs(amounts[2] / amounts[0] - 0.5) < 1e-4, 'alpha must scale persistent gas injection');

    await open(true);
    const collision = await page.evaluate(async () => {
      window.seedGasSource(1, 1);
      const { system } = window.debugFluid;
      system.modules.filter(module => module.constructor.name === 'Collision').forEach(module => {
        if (module.lifetimeLoss !== 1) throw new Error('source collider must kill on contact');
      });
      const collisionModules = system.modules.filter(module => module.constructor.name === 'Collision').length;
      // Restore actual motion for the one seeded source, aimed through the slab.
      system.modules.filter(module => module.constructor.name === 'TransformByNoise')
        .forEach(module => { module.options.strength = 0; });
      window.moveParticle([0, 0, 0], [10, 0, 0], 0, 1);
      const first = await window.runFrames(1, 0.1);
      const second = await window.runFrames(1, 0.1);
      return { collisionModules, first, second, wall: await window.gasWallMetrics() };
    });
    assert.equal(collision.collisionModules, 1);
    assert.equal(collision.second.count, 0, 'a source must die at the wall rather than emit gas on the far side');
    assert.equal(collision.wall.leaked, 0);
    console.log('Gas source injection:', JSON.stringify({ amounts, wall: collision.wall }));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await site.close();
  }
});
