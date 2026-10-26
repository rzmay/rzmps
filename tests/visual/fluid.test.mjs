import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('fluid presets preserve scenes, the teapot fills, and reference gas fields decay as configured', { timeout: 180000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    await page.goto(`${origin}/?preset=Fire&scene=Checkerboard&renderer=webgl`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.psgui-demo select');
    for (const name of ['FLIP Fluid', 'Gas Volume', 'Gas Niagara Burst', 'Gas Blender Smoke']) {
      await page.evaluate(name => {
        const select = [...document.querySelectorAll('.psgui-demo select')]
          .find(select => [...select.options].some(option => option.textContent === name));
        select.value = [...select.options].find(option => option.textContent === name).value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, name);
      await page.waitForFunction(name => new URL(location.href).searchParams.get('preset') === name, {}, name);
      await page.waitForSelector('.psgui-demo select');
      assert.equal(new URL(page.url()).searchParams.get('scene'), 'Checkerboard');
      assert.equal(new URL(page.url()).searchParams.get('renderer'), 'webgpu');
    }
    await page.goto(`${origin}/?preset=FLIP%20Fluid`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.psgui-demo select');
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.psgui-demo select')]
      .some(select => select.selectedOptions[0].textContent === 'Checkerboard')));

    const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
    await page.goto(`${origin}/@fs${fixture}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.ready);
    const contact = await page.evaluate(() => window.probe([0, 0.5, 0], [0, -0.5, 0]));
    assert.equal(contact[3], 1, 'the teapot BVH must intercept a sweep through its bottom');
    assert.ok(contact[1] > -0.35, 'contact must select the inner surface before the outer underside');
    assert.ok(contact[9] > contact[1] + 0.05, 'the sphere center must stay one radius above contact');
    const flowing = await page.evaluate(() => window.runFrames(780));
    assert.ok(flowing.count > 5000, 'emission must retain enough particles to fill the vessel');
    assert.ok(flowing.newbornSpeed < 1.5, 'the emitter must retain its configured low speed after 13 seconds');
    const settled = await page.evaluate(() => window.runFrames(1020));
    assert.ok(settled.speed <= 6.01, 'velocity must remain bounded after 30 simulated seconds');
    assert.ok(settled.inContainer > settled.count * 0.9, 'the liquid must remain collected inside the actual teapot');

    await page.evaluate(() => window.moveParticle([30, 0, 0], [1, 0, 0]));
    await new Promise(resolve => setTimeout(resolve, 550));
    await page.evaluate(() => window.runFrames(1));
    await new Promise(resolve => setTimeout(resolve, 100));
    await page.evaluate(() => window.runFrames(60));
    const bounded = await page.evaluate(async () => {
      const { flip, system, renderer } = window.debugFluid;
      const grid = flip.getParticleSpatialGrid(system);
      const bounds = await grid.readBounds(renderer);
      const particles = await system.selectiveReadback(16000, ['position', 'velocity']);
      const escaped = particles.find(({ particle }) => particle.position.x > 30);
      return { side: bounds.max.x - bounds.min.x, cellSize: flip.cellSize,
        escapedSpeedX: escaped?.particle.velocity.x, escapedX: escaped?.particle.position.x };
    });
    assert.equal(bounded.side, 16, 'an escaped marker must not coarsen the entire fluid domain');
    assert.equal(bounded.cellSize, 0.25);
    assert.ok(bounded.escapedX > 30.5, 'escaped markers remain ballistic, not contained by an artificial wall');
    assert.ok(Math.abs(bounded.escapedSpeedX - 1) < 1e-5, 'escaped markers must not sample clamped edge velocities');

    for (const example of ['gasNiagaraBurst', 'gasBlenderSmoke']) {
      await page.goto(`${origin}/@fs${fixture}?example=${example}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready);
      const initial = await page.evaluate(() => window.runFrames(30));
      const cooled = await page.evaluate(() => window.runFrames(210));
      assert.ok(initial.field.sum > 0, `${example}: the particle burst must inject gas`);
      if (example === 'gasNiagaraBurst') {
        assert.ok(cooled.field.sum < initial.field.sum * 0.01, 'Niagara burst should fade rapidly with dissipation 3');
      } else {
        assert.ok(cooled.field.sum > initial.field.sum * 0.4, 'smoke with dissolve disabled should persist');
        assert.ok(cooled.field.heat / cooled.field.sum < initial.field.heat / initial.field.sum,
          'retained smoke should cool even when density dissolve is disabled');
      }
    }
    const rotating = [];
    for (const strength of [0, 2]) {
      await page.goto(`${origin}/@fs${fixture}?example=gasBlenderSmoke`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready);
      await page.evaluate(() => window.runFrames(30));
      await page.evaluate(strength => {
        window.seedGas();
        window.debugFluid.flip.vorticityStrength = strength;
      }, strength);
      const stats = await page.evaluate(() => window.runFrames(120));
      assert.ok(stats.field.sum > 300, 'the seeded cool field must remain present');
      assert.equal(stats.field.heat, 0, 'the test must not depend on buoyancy');
      rotating.push(stats.field.rmsSpeed);
    }
    assert.ok(rotating[1] > rotating[0] * 1.5,
      'curl confinement must preserve rotation without temperature, noise, or new particles');
    assert.deepEqual(errors, [], 'WebGPU passes and renderer changes must not produce browser errors');
  } finally {
    await browser?.close();
    await site.close();
  }
});
