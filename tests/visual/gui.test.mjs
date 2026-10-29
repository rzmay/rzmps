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
    const args = ['--disable-dev-shm-usage', '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'];
    if (process.env.CI === 'true') {
      args.push('--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader');
    } else args.push('--use-angle=default');
    browser = await puppeteer.launch({ headless: true, args });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const cases = ['Snow', 'LOD Stress Test', 'Fireworks', 'Fire', 'Fireflies'].map(preset => [preset, 'webgl']);
    cases.push(['Fireflies', 'webgpu']);
    for (const [preset, backend] of cases) {
      await page.goto(`${origin}/?preset=${encodeURIComponent(preset)}&renderer=${backend}`, {
        waitUntil: 'networkidle0',
      });
      await page.waitForSelector('.psgui-renderers', { timeout: 15000 });
      if (backend === 'webgpu') {
        await page.waitForFunction(() => /GPU slots/.test(
          document.querySelector('.particle-count-monitor')?.textContent ?? '',
        ));
      }
      const folders = await page.$$eval('.lil-gui .lil-title', elements => (
        elements.map(element => element.textContent)
      ));
      assert.ok(folders.includes('LOD'), `${preset}: population LOD controls`);
      assert.ok(folders.includes('Renderer Children'), `${preset}: renderer children controls`);
      if (preset === 'Fireflies') {
        assert.ok(folders.includes('Scene Settings'), 'Checkerboard exposes scene settings');
        const strength = await page.evaluate(() => {
          const control = [...document.querySelectorAll('.lil-gui .lil-controller')].find(element => (
            element.querySelector('.lil-name')?.textContent === 'Light Strength'
          ));
          const input = control?.querySelector('input[type="text"], input[type="number"]');
          if (!input) throw new Error('Checkerboard light strength control is missing');
          input.value = '0.08';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return Number(input.value);
        });
        assert.equal(strength, 0.08, 'scene light strength can be lowered without changing the particle system');
      }
      if (preset === 'Snow') {
        await page.waitForFunction(() => /[\d,]+ simulated \([\d,]+ rendered\)/.test(
          document.querySelector('.particle-count-monitor')?.textContent ?? '',
        ));
        const counts = await page.$eval('.particle-count-monitor', element => (
          element.textContent.match(/[\d,]+/g).map(value => Number(value.replaceAll(',', '')))
        ));
        assert.equal(counts[1], counts[0] * 6, 'Snow rendered total includes its five children per particle');
      } else if (preset === 'Fire') {
        const text = await page.$eval('.particle-count-monitor', element => element.textContent);
        assert.doesNotMatch(text, /rendered|children/, 'No child line when there are no children');
      }
      const toggled = await page.evaluate((preset) => {
        const title = [...document.querySelectorAll('.lil-gui .lil-title')].find(element => (
          element.textContent === 'LOD'
        ));
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
