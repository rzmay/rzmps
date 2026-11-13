import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/ambiguous-surface.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  for (const variant of [0, 1, 2]) for (const decider of [false, true]) {
    const result = await page.evaluate(({ variant, decider }) => window.extractAmbiguous(variant, decider),
      { variant, decider });
    console.log(JSON.stringify(result));
    assert(result.count > 0);
    if (decider) {
      assert.equal(result.openEdges, 0, 'shared ambiguous faces must remain watertight');
      assert.equal(result.nonManifoldEdges, 0);
    }
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
