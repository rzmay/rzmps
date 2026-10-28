import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/surface.html')}`);
  await page.waitForFunction(() => window.ready).catch(error => {
    throw new Error(`${error.message}\n${errors.join('\n')}`);
  });
  const results = await page.evaluate(async () => {
    const { surface } = window.surfaceFixture;
    surface.maxActiveBricks = 512;
    surface.maxTriangles = 100000;
    surface.smoothingIterations = 4;
    const results = [];
    for (const offset of [0, 0.5, -0.5, 0.125, 0]) {
      const samples = Array.from({ length: 64 }, (_, i) => ({
        position: [(i % 4 - 1.5) * 0.22 + offset,
          (Math.floor(i / 4) % 4 - 1.5) * 0.22 + offset,
          (Math.floor(i / 16) - 1.5) * 0.22 + offset],
        scale: [0.65, 0.65, 0.65], color: [0.1, 0.6, 1],
      }));
      results.push({ offset, ...await window.seedSurface(samples) });
    }
    return results;
  });
  console.log('Surface brick translation:', JSON.stringify(results));
  for (const result of results) {
    assert.equal(result.overflowedBricks, 0);
    assert.equal(result.overflowedTriangles, 0);
    assert.equal(result.openEdges, 0, 'a closed blob must remain closed across reused brick slots');
    assert.equal(result.components, 1);
    assert.equal(result.invalid, 0);
    assert.equal(result.reversed, 0);
    assert.equal(result.triangles, results[0].triangles, 'integer voxel translations preserve topology');
  }
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
