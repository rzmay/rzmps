import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const output = process.argv[2] ?? '/tmp/liquid-reliability';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('benchmark', { protocolTimeout: 300000 }));
  const page = await browser.newPage(), errors = [];
  await fs.mkdir(output, { recursive: true });
  let checkpoints = Promise.resolve();
  await page.exposeFunction('recordReliabilityCheckpoint', record => {
    checkpoints = checkpoints.then(() => fs.appendFile(path.join(output, 'checkpoints.jsonl'),
      JSON.stringify(record) + '\n'));
    return checkpoints;
  });
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.LIQUID_PRESSURE === '1') page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.setViewport({ width: 1000, height: 800 });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
    + '?demoLiquid&reliability&measureStartup&prepareStartup'
    + (process.env.LIQUID_PRESSURE === '1' ? '&pressureQuality=4' : ''), errors);
  if (process.env.LIQUID_PRESSURE === '1') {
    const result = await page.evaluate(async module => {
      const { renderer, system, scene, camera, flip, sceneLifecycle } = window.debugFluid;
      for (let frame = 0; frame < 120; frame++) {
        sceneLifecycle.update?.(1 / 60); system.advanceFrames(1, 1 / 60);
        await renderer.renderAsync(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
      }
      const { default: profile } = await import(module);
      return profile(flip, renderer);
    }, `/@fs${path.resolve('apps/demo/benchmarks/fluids/profileFrozenLiquidPressure.js')}`);
    await fs.writeFile(path.join(output, 'pressure.json'), JSON.stringify({ ...result, errors }, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Reference teapot prepared; starting', process.env.LIQUID_MODE ?? 'raf');
    const result = await page.evaluate(async options => {
      const { default: run } = await import(options.module);
      const result = await run(options);
      window.liquidReliabilityResult = result;
      // Return compact metadata first. Deep traces can exceed a single DevTools result payload.
      const { frames, spikes, resources: _resources, graphBuilds: _builds, ...summary } = result;
      return { ...summary, frameCount: frames.length, spikeCount: spikes.length };
    }, { module: `/@fs${path.resolve('apps/demo/benchmarks/fluids/runLiquidReliability.js')}`,
      seconds: Number(process.env.LIQUID_SECONDS ?? 45), mode: process.env.LIQUID_MODE ?? 'raf',
      warmupSeconds: Number(process.env.LIQUID_WARMUP ?? 0),
      threshold: Number(process.env.LIQUID_SPIKE_MS ?? 16.67), foam: process.env.LIQUID_FOAM !== '0',
      neighborCounts: process.env.LIQUID_NEIGHBOR_COUNTS !== '0' });
    await fs.mkdir(output, { recursive: true });
    await checkpoints;
    const { frameCount, spikeCount, ...summary } = result;
    const framesFile = await fs.open(path.join(output, 'frames.json'), 'w');
    try {
      await framesFile.write('[');
      for (let offset = 0; offset < frameCount; offset += 120) {
        const chunk = await page.evaluate(offset =>
          window.liquidReliabilityResult.frames.slice(offset, offset + 120), offset);
        await framesFile.write((offset ? ',' : '') + JSON.stringify(chunk).slice(1, -1));
      }
      await framesFile.write(']');
    } finally { await framesFile.close(); }
    const { spikes, resources, graphBuilds } = await page.evaluate(() => {
      const { spikes, resources, graphBuilds } = window.liquidReliabilityResult;
      return { spikes, resources, graphBuilds };
    });
    await fs.writeFile(path.join(output, 'spikes.json'), JSON.stringify(spikes));
    await fs.writeFile(path.join(output, 'resources.json'), JSON.stringify(resources));
    await fs.writeFile(path.join(output, 'graph-builds.json'), JSON.stringify(graphBuilds));
    await fs.writeFile(path.join(output, 'summary.json'),
      JSON.stringify({ ...summary, browserErrors: errors }, null, 2));
    console.log(JSON.stringify({ ...summary, browserErrors: errors, spikes: spikeCount,
      memory: { afterRun: resources.afterRun, afterDestroy: resources.afterDestroy } }, null, 2));
    await page.evaluate(() => { delete window.liquidReliabilityResult; });
  }
} finally { await browser?.close(); await site.close(); }
