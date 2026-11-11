import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-surface-quality';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/surface.html')}`, errors);
  const samples = [];
  for (const x of [-0.3, 0, 0.3]) for (const y of [-0.3, 0, 0.3]) for (const z of [-0.3, 0, 0.3]) {
    samples.push({ position: [x, y, z], scale: [0.5, 0.5, 0.5], color: x < 0 ? [1, 0.2, 0] : [0, 0.5, 1] });
  }
  const cases = [
    { name: 'coarse', voxelSize: 0.125, particleRadiusScale: 1, isoLevel: 0.2, smoothingIterations: 0 },
    { name: 'baseline', voxelSize: 0.0625, particleRadiusScale: 1, isoLevel: 0.2, smoothingIterations: 0 },
    { name: 'fine', voxelSize: 0.03125, particleRadiusScale: 1, isoLevel: 0.2, smoothingIterations: 0 },
    { name: 'smoothed', voxelSize: 0.0625, particleRadiusScale: 1, isoLevel: 0.2, smoothingIterations: 3 },
    { name: 'wide-kernel', voxelSize: 0.0625, particleRadiusScale: 1.25, isoLevel: 0.2, smoothingIterations: 3 },
    { name: 'higher-iso', voxelSize: 0.0625, particleRadiusScale: 1, isoLevel: 0.35, smoothingIterations: 3 },
  ];
  const results = [];
  for (const { name, ...settings } of cases) {
    // First call compiles any new kernels; the retained sample measures the warm path.
    await page.evaluate(({ samples, settings }) => window.reconstructSurface(samples, settings), { samples, settings });
    const result = await page.evaluate(({ samples, settings }) => window.reconstructSurface(samples, settings),
      { samples, settings });
    assert.equal(result.invalid, 0);
    // Record topology defects instead of aborting an investigation before later cases.
    assert(result.triangles > 0);
    results.push({ name, settings, ...result });
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    console.log(name, JSON.stringify({ triangles: result.triangles, normalVariation: result.normalVariation,
      fencedMs: result.fencedMs, volume: result.volume, boundaryEdges: result.boundaryEdges,
      nonManifoldEdges: result.nonManifoldEdges }));
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
} finally { await browser?.close(); await site.close(); }
