import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build, preview } from 'vite';
import puppeteer from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../..');

test('demo GUI initializes population LOD, renderer children, and subsystem editors', { timeout: 180000 }, async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-gui-'));
  let server, browser;
  try {
    const config = {
      root: path.join(root, 'apps/demo'),
      configFile: path.join(root, 'apps/demo/vite.config.mjs'),
      logLevel: 'error',
      build: { outDir: output, emptyOutDir: true },
    };
    await build(config);
    server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } });
    const args = ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'];
    if (process.env.CI === 'true') args.push('--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
    else args.push('--use-angle=default');
    browser = await puppeteer.launch({ headless: true, args });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const preset of ['Snow', 'LOD Stress Test', 'Fireworks']) {
      await page.goto(`${origin}/?preset=${encodeURIComponent(preset)}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('.psgui-renderers', { timeout: 15000 });
      const folders = await page.$$eval('.lil-gui .lil-title', elements => elements.map(element => element.textContent));
      assert.ok(folders.includes('LOD'), `${preset}: population LOD controls`);
      assert.ok(folders.includes('Renderer Children'), `${preset}: renderer children controls`);
      const toggled = await page.evaluate((preset) => {
        const title = [...document.querySelectorAll('.lil-gui .lil-title')].find(element => element.textContent === 'LOD');
        const checkbox = title.closest('.lil-gui').querySelector('input[type="checkbox"]');
        const before = checkbox.checked;
        if (preset === 'Snow' && before) throw new Error('Snow LOD must default to disabled');
        if (preset === 'LOD Stress Test' && !before) throw new Error('LOD stress test LOD must default to enabled');
        checkbox.click();
        return checkbox.checked !== before;
      }, preset);
      assert.equal(toggled, true, `${preset}: LOD enable control works`);
      assert.deepEqual(errors, [], `${preset}: GUI initialization and editing must not throw`);
    }
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(output, { recursive: true, force: true });
  }
});
