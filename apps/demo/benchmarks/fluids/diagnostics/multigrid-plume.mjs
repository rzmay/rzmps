import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const output = process.argv[2] ?? '/tmp/multigrid-plume.json';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
const results = [], errors = [];
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { headless: true, protocolTimeout: 180000,
    args: [...browserLaunchOptions('diagnostic').args, '--enable-unsafe-webgpu'] }));
  for (const example of (process.env.EXAMPLES ?? 'volumetricSmoke,volumetricFire').split(',')) {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      let seed = 173;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    page.on('console', e => { if (e.type() === 'error') { errors.push(e.text()); console.error(e.text()); } });
    const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
    const helper = path.resolve(import.meta.dirname, 'fixtures/multigrid-plume.js');
    const query = new URLSearchParams({ example,
      ...(process.env.FPS !== '1' && process.env.DYNAMIC !== '1' ? { reviewGrid: '3,4' } : {}),
      ...(process.env.NODE_TRACE ? { nodeTrace: 'true' } : {}),
      ...(process.env.FPS === '1' && example === 'flipFluid' ? { demoLiquid: 'true' } : {}),
      ...(process.env.DYNAMIC === '1'
      ? { reviewGrid: '3,3' } : {}), prepareStartup: 'true' });
    await openFixture(page,
      `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?${query}`, errors,
      { timeout: 30000 });
    await page.addScriptTag({ type: 'module', url: `/@fs${helper}` });
    await page.waitForFunction(() => typeof window.comparePlumePressure === 'function');
    await page.evaluate(count => { window.pressureCaptureUpdates = count; }, Number(process.env.CAPTURE_UPDATES ?? 20));
    await page.evaluate(count => { window.pressureReferenceIterations = count; },
      Number(process.env.ITERATIONS ?? 16));
    await page.evaluate(frames => { window.pressureProbeFrames = frames; },
      JSON.parse(process.env.PROBE_UPDATES ?? '[150,450,630]'));
    await page.evaluate(value => { window.pressureCrossoverOnly = value; }, process.env.CROSSOVER === '1');
    await page.evaluate(frames => { window.fluidFPSWarmup = frames; },
      process.env.FPS_WARMUP ? Number(process.env.FPS_WARMUP) : null);
    const dynamic = process.env.DYNAMIC === '1';
    console.log(example, process.env.FPS === '1' ? 'full-frame FPS'
      : dynamic ? 'evolving topology and moving collider' : 'cold and warm pressure replay');
    results.push({ example, ...await page.evaluate(({ dynamic, frames, fps }) =>
      fps ? window.measureFluidFPS() : dynamic
      ? window.evolveMultigrid({ frames }) : window.comparePlumePressure(),
    { dynamic, fps: process.env.FPS === '1', frames: Number(process.env.FRAMES ?? 360) }) });
    await fs.writeFile(output, JSON.stringify({ results, errors }, null, 2));
    await page.close();
  }
  assert.deepEqual(errors, []);
  if (process.env.FPS !== '1') assert(results.every(r => r.results ? r.diagnostics.overflowedBricks === 0
    && r.results.every(c => c.stats.nonFiniteSamples === 0)
    : r.observations.length > 0 && r.observations.every(c => c.multigrid.nonFiniteSamples === 0
      && c.multigrid.maxVelocity <= c.iterative.maxVelocity * 1.1 + 1e-5)
      && r.pages.every(p => p.overflowedBricks === 0)));
} finally { await browser?.close(); await site.close(); }
