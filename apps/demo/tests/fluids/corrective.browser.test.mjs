import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-fluid-corrective';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
  });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/corrective.html')}`, errors);
  const preparation = await page.evaluate(() => window.testPreparation());
  assert.deepEqual(preparation.before, preparation.after, 'preparation must not advance time or emit');
  console.log('Preparation:', preparation);
  const scratch = await page.evaluate(() => window.testPressureScratchLease());
  assert(scratch.shared && scratch.compacted && scratch.retainedDuringCompilationOwnership);
  assert.equal(scratch.destructions, 1, 'shared scratch is destroyed only after its final owner, exactly once');
  console.log('Pressure scratch ownership:', scratch);
  const growth = await page.evaluate(() => window.testGrowth());
  console.log('Growth:', growth);
  assert(growth.retained);
  assert.equal(growth.next, 64);
  const allocation = await page.evaluate(() => window.testSparseAllocation());
  for (const snapshot of [allocation.full, allocation.recycled]) {
    const slots = snapshot.pages.filter(Boolean);
    assert.equal(slots.length, 4);
    assert.equal(new Set(slots).size, 4, 'parallel claims must never alias a resident slot');
    assert.deepEqual(snapshot.counters, [4, 2]);
  }
  for (const brick of allocation.retained)
    assert.equal(allocation.recycled.pages[brick], allocation.full.pages[brick], 'retained pages keep addresses');
  assert(allocation.empty.pages.every(page => page === 0));
  assert.deepEqual(allocation.empty.counters, [0, 0]);
  console.log('Sparse allocation: unique claims, retained pages, recycling and overflow passed.');
  await page.evaluate(() => window.testProjection('Iterative'));
  const iterative = await page.evaluate(() => window.testProjection('Iterative'));
  console.log('Iterative:', iterative);
  await page.evaluate(() => window.testProjection('Multigrid'));
  const multigrid = await page.evaluate(() => window.testProjection('Multigrid'));
  console.log('Multigrid:', multigrid);
  assert(Number.isFinite(multigrid.pressureResidual));
  assert(multigrid.maxDivergenceAfterProjection < multigrid.maxDivergenceBeforeProjection);
  assert(multigrid.pressureResidual < iterative.pressureResidual,
    'V-cycles must improve convergence at equal fine sweeps');
  const early = await page.evaluate(() => window.testEarlyStop());
  console.log('Early stop:', early);
  assert.equal(early.pressureIterations, 2);
  assert.equal(early.pressureResidual, 0);
  const boundary = await page.evaluate(() => window.testBoundary());
  console.log('Boundary:', boundary);
  assert(boundary.partial > 0);
  assert(Math.abs(boundary.wallSpeed - 7.5) < 1e-4);
  assert.equal(boundary.stationarySpeed, 0);
  await page.evaluate(() => window.visualizeBoundary('solid'));
  await page.screenshot({ path: path.join(output, 'solid-fraction.png') });
  await page.evaluate(() => window.visualizeBoundary('faces'));
  await page.screenshot({ path: path.join(output, 'face-openness.png') });
  const lifecycle = await page.evaluate(() => window.testBoundaryRemoval());
  console.log('Boundary lifecycle and pause:', JSON.stringify(lifecycle));
  assert(lifecycle.blocked.boundaryCells > 0);
  assert.equal(lifecycle.removed.boundaryCells, 0);
  assert.equal(lifecycle.paused.time, lifecycle.paused.after);
  assert.equal(lifecycle.paused.version, lifecycle.paused.afterVersion);
  assert.equal(lifecycle.paused.opacity, 0.41);
  assert.equal(lifecycle.paused.steps, 79);
  assert.equal(lifecycle.paused.color, null);
  const resized = await page.evaluate(() => window.testTransfer(0, true));
  console.log('Bounds velocity:', JSON.stringify(resized.resized));
  assert.equal(resized.resized.side, resized.resized.previousSide * 2);
  assert(Math.abs(resized.resized.after / resized.resized.before - 1) < 0.02,
    'doubling the domain must preserve uniform world-space marker velocity');
  const transfers = [];
  for (const ratio of [0, 0.05]) {
    const transfer = await page.evaluate(ratio => window.testTransfer(ratio), ratio);
    assert(transfer.kineticEnergyBeforeTransfer > 0);
    assert(Number.isFinite(transfer.kineticEnergyAfterTransfer));
    transfers.push(transfer);
    console.log('Transfer:', JSON.stringify(transfer));
  }
  assert(Math.abs(transfers[0].kineticEnergyAfterTransfer / transfers[0].kineticEnergyBeforeTransfer - 1) < 1e-4);
  assert(transfers[1].kineticEnergyAfterTransfer <= transfers[1].kineticEnergyBeforeTransfer * 1.01);
  const coverage = await page.evaluate(() => window.testFractionalVisualCoverage());
  console.log('Fractional visual coverage:', coverage);
  assert(coverage.empty > 0 && coverage.partial > 0 && coverage.full > 0);
  assert.equal(coverage.invalidTemperature, 0);
  assert(coverage.physicsUnchanged);
  const restart = await page.evaluate(() => window.testRestart());
  console.log('Restart:', restart);
  assert.equal(restart.nonfinite, 0);
  assert(restart.maxDensity < 0.5, 'clear/reset must discard the previous persistent gas field');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify({
    preparation, growth, iterative, multigrid, early, boundary, lifecycle, resized, transfers, restart,
  }, null, 2));
} finally { await browser?.close(); await site.close(); }
