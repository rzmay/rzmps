import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

test('GPU renderer grouping matches CPU aggregates without simulation readback', {
  timeout: 180000,
}, async () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const server = await createServer({
    root, configFile: path.join(root, 'apps/demo/vite.config.mjs'),
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({
      headless: true,
      args: process.env.CI === 'true'
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-webgpu',
          '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
          '--use-webgpu-adapter=swiftshader', '--use-gpu-in-tests']
        : ['--use-angle=default'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/visual/renderer-grouping.html`);
    await page.waitForFunction('window.groupingResult', { timeout: 150000 });
    const result = await page.evaluate(() => window.groupingResult);
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(errors, []);
    assert.deepEqual(result.counts, [5, 13, 1, 0, 7]);
    assert.equal(result.readbacks, 0);
    console.log('GPU grouping timing:', JSON.stringify(result.timing));
  } finally {
    await browser?.close();
    await server.close();
  }
});
