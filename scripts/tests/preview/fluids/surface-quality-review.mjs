import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-surface-quality-v2';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/surface.html')}`, errors);
  const sample = (x, y, z, diameter = 0.5) => ({ position: [x, y, z],
    scale: [diameter / 2.4, diameter / 2.4, diameter / 2.4],
    color: x < 0 ? [1, 0.2, 0] : [0, 0.5, 1], velocity: [-y, x + 0.5, z * 0.3] });
  const block = (side, spacing, diameter) => Array.from({ length: side ** 3 }, (_, i) => sample(
    (i % side - (side - 1) / 2) * spacing,
    (Math.floor(i / side) % side - (side - 1) / 2) * spacing,
    (Math.floor(i / (side * side)) - (side - 1) / 2) * spacing, diameter));
  const scenarios = {
    bulk: block(5, 0.18, 0.35), sparse: block(3, 0.3, 0.5),
    droplets: [sample(-0.7, -0.4, 0, 0.12), sample(0.7, -0.4, 0, 0.2), sample(0, 0.6, 0, 0.4)],
    sheet: Array.from({ length: 49 }, (_, i) => sample((i % 7 - 3) * 0.18, 0,
      (Math.floor(i / 7) - 3) * 0.18, 0.35)),
    jet: Array.from({ length: 15 }, (_, i) => sample(0.05 * Math.sin(i * 0.3), (i - 7) * 0.16, 0, 0.22)),
    splash: Array.from({ length: 60 }, (_, i) => {
      const angle = (i % 12) / 12 * Math.PI * 2, t = Math.floor(i / 12) / 4;
      return sample(Math.cos(angle) * (0.25 + t), t * (1 - t) * 2,
        Math.sin(angle) * (0.25 + t), 0.24 - t * 0.08);
    }),
  };
  const teapot = await page.evaluate(() => window.captureTeapot());
  assert(teapot.samples.length > 0, 'capture a real, fixed teapot particle state');
  scenarios.teapot = teapot.samples;
  await fs.writeFile(path.join(output, 'teapot-snapshot.json'), JSON.stringify(teapot, null, 2));
  const variants = [
    { name: 'legacy', reconstructionVersion: 1, particleRadius: 2.4, fieldSmoothingIterations: 0, anisotropy: 0 },
    { name: 'spherical', reconstructionVersion: 2, particleRadius: 1.55, fieldSmoothingIterations: 0, anisotropy: 0 },
    { name: 'filtered', reconstructionVersion: 2, particleRadius: 1.55, fieldSmoothingIterations: 1,
      fieldSmoothing: 0.2, fieldClosing: 0.25, anisotropy: 0 },
    { name: 'anisotropic', reconstructionVersion: 2, particleRadius: 1.55, fieldSmoothingIterations: 1,
      fieldSmoothing: 0.2, fieldClosing: 0.25, anisotropy: 0.7 },
  ];
  const results = [];
  for (const [scenario, samples] of Object.entries(scenarios)) {
    for (const variant of variants) for (const extraction of ['SurfaceNets', 'MarchingCubes']) {
      const settings = { ...variant, extraction, maxActiveBricks: 512, maxTriangles: 60000,
        voxelSize: 0.0625, isoLevel: 0.2, smoothingIterations: 0, fieldClosing: 0, influenceRadius: 2.2,
        ...variant };
      const result = await page.evaluate(({ samples, settings }) => window.reconstructSurface(samples, settings),
        { samples, settings });
      assert.equal(result.invalid, 0, `${scenario}/${variant.name}/${extraction}`);
      assert(result.triangles > 0);
      results.push({ scenario, variant: variant.name, extraction, settings, ...result });
      await page.screenshot({ path: path.join(output, `${scenario}-${variant.name}-${extraction}.png`) });
      console.log(JSON.stringify({ scenario, variant: variant.name, extraction, triangles: result.triangles,
        volume: result.volume, normalVariation: result.normalVariation, boundaryEdges: result.boundaryEdges,
        nonManifoldEdges: result.nonManifoldEdges, reconstructionFencedMs: result.reconstructionFencedMs,
        allocatedBytes: result.allocatedBytes, overflowedBricks: result.overflowedBricks }));
    }
    // Same reconstructed field, flow-driven material on/off; these do not alter the particles or field settings.
    for (const enabled of [false, true]) {
      await page.evaluate(({ samples, enabled }) => window.reconstructSurface(samples, {
        ...window.lastSurfaceSettings, reconstructionVersion: 2, extraction: 'SurfaceNets',
        particleRadius: 1.55, anisotropy: 0.7, flowMaterial: enabled,
      }), { samples, enabled });
      await page.screenshot({ path: path.join(output, `${scenario}-flow-${enabled}.png`) });
    }
  }
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
} finally { await browser?.close(); await site.close(); }
