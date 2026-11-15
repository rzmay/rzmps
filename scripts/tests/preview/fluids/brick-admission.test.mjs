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
  const fixture = path.resolve(import.meta.dirname, 'fixtures/corrective.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const result = await page.evaluate(() => window.testPriorityAdmission());
  console.log(JSON.stringify(result));
  assert(result.retained && result.admittedCritical && result.evictedOptional && result.unique);
  assert(result.cleared[0].maximumPhysicalDensity > 0, 'retained state must not be fresh-cleared');
  assert(result.cleared.slice(1).every(brick => brick.fresh && brick.maximumPhysicalDensity === 0));
  for (const brick of [...result.written, ...result.recycled]) {
    assert(brick.logical && brick.resident && brick.active);
    assert(brick.maximumPhysicalDensity > 0 && brick.maximumExportDensity > 0 && brick.rendererOccupied);
    assert.equal(brick.admissionFrame, brick.firstSimulationWriteFrame);
    assert.equal(brick.admissionFrame, brick.firstExportFrame);
  }
  for (const image of result.frozenImages) {
    assert(image.withoutSkipping > 0, 'the frozen volume must produce visible pixels');
    assert(image.withSkipping / image.withoutSkipping > 0.85, 'occupancy must not hide populated bricks');
  }
  const transport = await page.evaluate(() => window.testTransportRequests());
  console.log('Fractional transport:', JSON.stringify(transport));
  for (const brick of [transport.first, transport.second]) assert(brick.resident && brick.priority >= 4);
  const rectangular = await page.evaluate(() => window.testRectangularBrickDomain());
  console.log('Rectangular domain:', JSON.stringify(rectangular));
  assert(rectangular.receiverRing && rectangular.distantUnallocated && rectangular.grew && rectangular.sameFields);
  assert.equal(rectangular.resident, 27);
  assert.equal(rectangular.occupied, 1);
  assert.equal(rectangular.logical, 64);
  assert.equal(rectangular.before, 64);
  assert.equal(rectangular.after, 80);
  assert(rectangular.newFaceEmpty);
  const invalidation = await page.evaluate(() => window.testBoundaryTopologyInvalidation());
  console.log('Boundary invalidation:', JSON.stringify(invalidation));
  assert.equal(invalidation.initial, 1);
  assert.equal(invalidation.bindingReset, 1, 'field rebinding must not cancel pending boundary preparation');
  assert.equal(invalidation.geometryChange, 2);
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
