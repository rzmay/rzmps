import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-fluid-startup';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const results = {};
  for (const example of process.env.FLUID_EXAMPLES?.split(',') ?? ['volumetricFire', 'flipFluid']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}` +
      `?example=${example}&demoLiquid=true&measureStartup&prepareStartup&scene=movingColliders`
      + (process.env.RENDER_DURING_PREPARATION ? '&renderDuringPreparation' : ''), errors);
    const result = await page.evaluate(async () => {
      const { system, renderer, scene, camera } = window.debugFluid;
      const warm = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        system.advanceFrames(1, 1 / 60);
        await renderer.renderAsync(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        warm.push(performance.now() - start);
      }
      const stats = {};
      for (const call of window.fluidStartup.backendCalls) {
        const key = `${call.phase}:${call.name}`;
        stats[key] ??= { calls: 0, cpuMs: 0, bytes: 0 };
        stats[key].calls++;
        stats[key].cpuMs += call.cpuMs;
        stats[key].bytes += call.bytes;
      }
      const { backendCalls: _calls, ...startup } = window.fluidStartup;
      return { ...startup, backend: stats, warmFencedMs: warm };
    });
    assert.deepEqual(errors, []);
    results[example] = result;
    await page.screenshot({ path: path.join(output, `${example}.png`) });
    console.log(example, JSON.stringify(result));
    await page.close();
  }
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
