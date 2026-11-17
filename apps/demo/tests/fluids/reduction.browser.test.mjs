import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/reduction.html')}`, errors);
  for (const count of [64, 257, 20000]) {
    const data = await page.evaluate(count => window.reduce(count), count);
    await fs.writeFile(`/tmp/rzmps-reduction-${count}.json`, JSON.stringify(data));
    console.log(count, JSON.stringify({ result: data.result, partial: data.partial }));
    assert.deepEqual(data.result, [1, 2, 3, 4, 1, 2, 3, 4, count, 0, 0, 0]);
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
