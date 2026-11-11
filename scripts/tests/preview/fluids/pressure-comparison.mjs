import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-pressure-comparison';
await fs.mkdir(output, { recursive: true });
const cases = [
  { bricks: 2, cells: 2, active: 64, sources: 1 },
  { bricks: 2, cells: 3, active: 64, sources: 32, obstacle: 'sphere' },
  { bricks: 3, cells: 2, active: 16, sources: 128, obstacle: 'diagonal' },
];
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const results = [];
  for (const options of cases) {
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
      path.resolve(import.meta.dirname, 'fixtures/corrective.html')}?${new URLSearchParams(options)}`, errors);
    await page.evaluate(() => window.testPreparation());
    await page.evaluate(() => window.testGrowth());
    const result = { options };
    for (const solver of ['Iterative', 'Multigrid']) {
      await page.evaluate(solver => window.testProjection(solver), solver);
      result[solver] = await page.evaluate(solver => window.testProjection(solver), solver);
      console.log(JSON.stringify({ options, solver, ...result[solver] }));
      assert.equal(result[solver].nonFiniteSamples, 0);
      assert(Number.isFinite(result[solver].pressureResidual));
      assert(result[solver].maxDivergenceAfterProjection < result[solver].maxDivergenceBeforeProjection);
    }
    assert(result.Multigrid.pressureResidual <= result.Iterative.pressureResidual * 1.05,
      'multigrid cannot trade correctness for speed');
    results.push(result);
    console.log(JSON.stringify(result));
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
} finally { await browser?.close(); await site.close(); }
