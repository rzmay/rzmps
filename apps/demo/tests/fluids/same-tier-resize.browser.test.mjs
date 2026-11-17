import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/same-tier-resize.html');
  const query = process.env.BASELINE ? '?baseline' : '';
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}${query}`, errors);
  const results = [];
  for (const kind of ['gas', 'flip'].filter(kind => !process.env.KIND || kind === process.env.KIND))
    for (const change of ['grow', 'translate', 'jump', 'shrink']
      .filter(change => !process.env.CHANGE || change === process.env.CHANGE)) {
    const result = await page.evaluate(({ kind, change }) => window.measureResize(kind, change), { kind, change });
    console.log(JSON.stringify(result)); results.push(result);
    if (process.env.BASELINE) continue;
    assert(result.exact && result.retained > 0);
    assert(result.sameFields && result.sameDirectory && result.sameGrid && result.samePressure);
    assert(result.sameTexture && result.sameTransport && result.samePressureGraphs);
    assert.equal(result.capacityChanged, false); assert.equal(result.graphResets, 0);
    assert.equal(result.pipelines, 0, 'same-tier changes must reuse compiled compute pipelines');
  }
  const coverage = await page.evaluate(() => window.verifyImmediateCoverage());
  console.log(JSON.stringify({ coverage }));
  assert(coverage.covered && coverage.retainsSupport && coverage.boundedExport && coverage.retainedDensity);
  assert(coverage.sameFields && coverage.sameTexture && coverage.helperDirectory && coverage.helperRectangle);
  assert.equal(coverage.helperInstances, coverage.logicalBricks);
  let backing, flipGrowth;
  if (process.env.CAPACITY) {
    backing = await page.evaluate(() => window.measureBackingGrowth());
    console.log(JSON.stringify({ backing }));
    assert(backing.ready && backing.staged && backing.retained === 8);
    assert(backing.capacity > backing.originalCapacity);
    assert(backing.textureReady && backing.textureStaged && backing.textureChanged);
    assert(backing.sameResident && backing.samePressure && backing.sameExport);
    flipGrowth = await page.evaluate(() => window.measureFlipPoolGrowth());
    console.log(JSON.stringify({ flipGrowth }));
    assert(flipGrowth.committed && flipGrowth.exact && flipGrowth.capacity > flipGrowth.previous);
    assert.equal(flipGrowth.requests, 1, 'logical growth must not restart prepared resident capacity');
    assert.deepEqual(flipGrowth.dimensions, [8, 12, 8]);
  }
  await fs.writeFile(process.env.OUTPUT ?? '/tmp/rzmps-same-tier-resize.json',
    JSON.stringify({ results, backing, flipGrowth, errors }, null, 2));
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
