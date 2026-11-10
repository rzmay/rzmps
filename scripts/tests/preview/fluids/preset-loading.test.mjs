import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

test('fluid and gas demo catalogs initialize the canvas and GUI', { timeout: 120000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-preset-loading-'));
  let browser;

  try {
    browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => {
      if (message.type() === 'error') {
        errors.push(message.text());
        console.error(message.text());
      }
    });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const presets = ['FLIP Fluid', 'Gas Volume', 'Gas Niagara Burst', 'Gas Blender Smoke'];

    for (const [index, preset] of presets.entries()) {
      await page.goto(`${origin}/?preset=${encodeURIComponent(preset)}&scene=Checkerboard`,
        { waitUntil: 'networkidle0' });
      await page.waitForFunction(preset => [...document.querySelectorAll('.psgui-demo select')]
        .some(select => select.value === preset), { timeout: 20000 }, preset)
        .catch(error => { throw new Error(`${preset}: ${error.message}\n${errors.join('\n')}`); });
      await page.waitForFunction(() => /[1-9][\d,]* GPU slots/.test(
        document.querySelector('.particle-count-monitor')?.textContent), { timeout: 20000 });
      // The reference gas bursts finish before network idle; continuous demos must still have live particles.
      if (index < 2) {
        await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('.particle-count-monitor')?.textContent),
          { timeout: 20000 });
      }
      assert.ok(await page.$('canvas'));
      assert.deepEqual(errors, [], preset);
      await page.screenshot({ path: path.join(output, `${index}.png`) });
      console.log(`Loaded ${preset} with canvas, GUI, and GPU simulation.`);
    }

    // Switching through the existing GUI must preserve the current scene too.
    await page.select('.psgui-demo select', 'FLIP Fluid');
    await page.waitForFunction(() => document.querySelector('.psgui-modules')?.textContent.includes('FLIPSimulation'));
    assert.equal(new URL(page.url()).searchParams.get('scene'), 'Checkerboard');
    assert.deepEqual(errors, []);
    console.log(`Preset screenshots: ${output}`);
  } finally {
    await browser?.close();
    await site.close();
  }
});
