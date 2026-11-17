import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const build = path.resolve('packages/rzmps/build/index.mjs');
const previous = process.env.BASELINE ? await fs.readFile(build) : undefined;
if (previous) await fs.writeFile(build, await fs.readFile(process.env.BASELINE));
let site, browser;
try {
  site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  await site.demo.watcher.close();
  browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/corrective.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?bricks=3&cells=4&reserve=128&maximum=256&active=200'
    + `&solver=${process.env.SOLVER ?? 'Iterative'}`, errors);
  await page.evaluate(() => window.testPreparation());
  const growth = await page.evaluate(() => window.testGrowth(256));
  assert.equal(growth.capacity, 128);
  assert.equal(growth.next, 256);
  assert(growth.retained, JSON.stringify(growth.mismatchedFields));
  if (!process.env.BASELINE) {
    assert(growth.growthMetrics.sameGraphs);
    assert.equal(growth.growthMetrics.pipelines, 0);
    assert.equal(growth.growthMetrics.compilationMs, 0);
    assert(growth.cachedWriteExact);
    assert(growth.newSentinelsZero);
    assert.equal(growth.followupPipelines, 0);
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(process.env.OUTPUT ?? '/tmp/rzmps-resident-capacity.json',
    JSON.stringify({ growth, errors }, null, 2));
  console.log(JSON.stringify(growth));
} finally {
  await browser?.close(); await site?.close();
  if (previous) await fs.writeFile(build, previous);
}
