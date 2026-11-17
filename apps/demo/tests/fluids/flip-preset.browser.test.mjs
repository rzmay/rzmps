import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from './openFixture.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';

test('switching to FLIP builds the foam editor and keeps the particle loop responsive',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 45000 }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && !message.text().includes('504 (Outdated Optimize Dep)'))
          errors.push(message.text());
      });
      await page.evaluateOnNewDocument(() => Object.defineProperty(window, 'ready', { get: () =>
        [...document.querySelectorAll('.lil-gui select')]
          .some(select => [...select.options].some(option => option.textContent === 'FLIP Fluid')) }));
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/example/fire?renderer=webgpu`, errors);
      await page.evaluate(() => {
        const select = [...document.querySelectorAll('.lil-gui select')]
          .find(select => [...select.options].some(option => option.textContent === 'FLIP Fluid'));
        select.value = [...select.options].find(option => option.textContent === 'FLIP Fluid').value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('.lil-gui')?.textContent.includes('SurfaceAttachment')
        && document.querySelector('.particle-count-monitor__simulation')?.textContent.startsWith('FLIP:')
        && Number.parseInt(document.querySelector('.particle-count-monitor')?.textContent.replaceAll(',', '')) > 0,
      { timeout: 30000 });
      const heartbeat = await page.evaluate(() => new Promise(resolve => {
        const started = performance.now();
        setTimeout(() => resolve(performance.now() - started), 100);
      }));
      assert(heartbeat < 2000, `Main thread stalled for ${heartbeat}ms after FLIP selection`);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
