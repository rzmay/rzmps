import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 180000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?example=volumetricSmoke&scene=wind&measureStartup&prepareStartup', errors);
  const result = await page.evaluate(async options => {
    const { renderer, system, scene, camera, flip: gas } = window.debugFluid;
    const { gasMoments } = await import(options.metrics);
    const samples = [], transitions = [], pending = [];
    const remap = gas.remapFields;
    gas.remapFields = function (...args) {
      const old = this.pendingPreviousGrid;
      if (!old || old.cellSize === this.volumeGrid.cellSize) return remap.apply(this, args);
      const before = gasMoments(this, renderer, old, this.densityCurrent);
      const result = remap.apply(this, args);
      const after = gasMoments(this, renderer);
      pending.push(Promise.all([before, after]).then(([before, after]) =>
        transitions.push({ time: system._elapsedTime, before, after })));
      return result;
    };
    try {
      for (let frame = 0; frame < 900; frame++) {
        system.advanceFrames(1, 1 / 60);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        if (frame % 60 === 0) {
          samples.push({ time: (frame + 1) / 60, ...await gasMoments(gas, renderer),
            changes: { ...gas.domainChanges }, diagnostics: await gas.readGridDiagnostics(renderer) });
          await renderer.renderAsync(scene, camera);
        }
      }
      await Promise.all(pending);
      const wind = scene.getObjectByName('Wind');
      return { samples, transitions, configuration: {
        wind: wind.direction.toArray(), drag: wind.drag, scalarDiffusion: gas.scalarDiffusion,
        sourceStrength: gas.sourceStrength, sourceRate: system.emitters[0].rate,
        supportSpatialEffects: gas.supportSpatialEffects, maxVelocity: gas.maxVelocity,
      } };
    } finally { gas.remapFields = remap; }
  }, { metrics: `/@fs${path.resolve('apps/demo/benchmarks/fluids/gasQualityMetrics.utils.js')}` });
  await fs.writeFile(process.argv[2] ?? '/tmp/gas-quality-wind.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ ...result, errors }, null, 2));
} finally { await browser?.close(); await site.close(); }
