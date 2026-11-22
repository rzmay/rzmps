import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../scripts/browser/launch.utils.mjs';

test('full demo builds the system GUI, exports code, and switches scenes', { timeout: 90000 }, async () => {
  const server = await createServer({ root: path.resolve(import.meta.dirname, '..'),
    server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  let browser;
  try {
    await server.listen();
    await server.watcher.close();
    browser = await puppeteer.launch(browserLaunchOptions('test'));
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith('https://avatars.githubusercontent.com/')) request.abort();
      else request.continue();
    });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    await page.goto(`${origin}/?preset=Snow&scene=Checkerboard&renderer=webgl`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.psgui-renderers', { timeout: 30000 });
    const controls = await page.$$eval('.psgui-system .lil-name', nodes => nodes.map(node => node.textContent));
    assert(controls.includes('Max Catchup'), 'the root GUI must delegate generic value editing');
    assert(controls.includes('Substep Delta Time'));
    assert.deepEqual(errors, [], 'initialization, including initial code export, must complete');

    const liquid = await page.evaluate(async root => {
      const { examples } = await import('/@fs' + root + '/examples/index.js');
      const entries = examples.filter(entry => entry.id === 'flipFluid');
      return { count: entries.length, backend: entries[0]?.previewSettings.backend,
        scene: entries[0]?.previewSettings.scene.metadata.id, source: entries[0]?.sourceUrl,
        last: examples.at(-1).id };
    }, path.resolve(import.meta.dirname, '../../..'));
    assert.deepEqual(liquid, { count: 1, backend: 'webgpu', scene: 'fluidTeapot',
      source: 'https://github.com/rzmay/rzmps/blob/develop/examples/presets/flipFluid.js', last: 'flipFluid' });

    await page.evaluate(() => {
      const scene = [...document.querySelectorAll('.psgui-demo select')].find(select =>
        [...select.options].some(option => option.text === 'Wind'));
      if (!scene) throw new Error('Scene selector is missing');
      scene.value = [...scene.options].find(option => option.text === 'Wind').value;
      scene.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => new URL(location.href).searchParams.get('scene') === 'Wind');
    await page.waitForNetworkIdle();
    await page.waitForSelector('.psgui-renderers');
    assert.deepEqual(errors, [], 'scene replacement must preserve GUI and export initialization');
  } finally {
    await browser?.close();
    await server.close();
  }
});
