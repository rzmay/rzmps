import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const query = process.argv.includes('--stages') ? '?stages' : '';
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`
    + `/tests/visual/renderer-grouping-performance.html${query}`);
  await page.waitForFunction('window.performanceResult', { timeout: 180000 });
  const result = await page.evaluate(() => window.performanceResult);
  assert.equal(result.error, undefined, result.error);
  assert.deepEqual(errors, []);
  const file = process.argv.slice(2).find(argument => !argument.startsWith('--'))
    ?? '/tmp/rzmps-renderer-grouping-performance.json';
  await fs.writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await server.close(); }
