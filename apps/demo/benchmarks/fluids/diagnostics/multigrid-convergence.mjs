import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const output = process.argv[2] ?? '/tmp/multigrid-convergence.json';
const shapes = process.env.SHAPES ? JSON.parse(process.env.SHAPES) : [[64, 64, 64], [16, 64, 8], [1, 64, 2]];
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
const results = [], errors = [];
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { headless: true, protocolTimeout: 180000,
    args: [...browserLaunchOptions('diagnostic').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/multigrid-convergence.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const transfers = await page.evaluate(() => window.transferTests());
  const topology = await page.evaluate(() => window.testTopologyReuse());
  await fs.writeFile(output, JSON.stringify({ results, transfers, topology, errors }, null, 2));
  for (const dimensions of shapes) for (const obstacle of [false, true]) {
    console.log('Convergence', dimensions, 'obstacle', obstacle);
    results.push(await page.evaluate(options => window.runConvergence(options),
      { dimensions, obstacle, referenceIterations: Number(process.env.ITERATIONS ?? 16),
        crossoverOnly: process.env.CROSSOVER === '1' }));
    await fs.writeFile(output, JSON.stringify({ results, transfers, topology, errors }, null, 2));
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
