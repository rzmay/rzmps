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
    assert.deepEqual(errors, [], 'WebGPU passes and renderer changes must not produce browser errors');
  } finally {
    await browser?.close();
    await site.close();
  }
});
