import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
const server = await createServer({ root: path.resolve(import.meta.dirname, '../..'),
  configFile: path.resolve(import.meta.dirname, '../../apps/demo/vite.config.mjs'),
  server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.log(message.text());
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/visual/spatial-aggregation.html`);
  await page.waitForFunction('window.spatialResult', { timeout: 120000 });
  const result = await page.evaluate(() => window.spatialResult);
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(errors, []);
  console.log('Spatial aggregation:', JSON.stringify(result));
} finally {
  await browser?.close();
  await server.close();
}
