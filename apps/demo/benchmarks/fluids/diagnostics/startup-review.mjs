import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-fluid-startup';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 120000 }));
  const results = {};
  for (const example of process.env.FLUID_EXAMPLES?.split(',') ?? ['volumetricFire', 'flipFluid']) {
    const page = await browser.newPage();
    const errors = [];
    const cdp = process.env.PROFILE_STARTUP ? await page.createCDPSession() : undefined;
    if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); }
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const fixture = path.resolve(import.meta.dirname, '../../../tests/fluids/fixtures/fluid.html');
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}` +
      `?example=${example}&demoLiquid=true&measureStartup&prepareStartup&scene=movingColliders`
      + (process.env.RENDER_DURING_PREPARATION ? '&renderDuringPreparation' : ''), errors);
    const result = await page.evaluate(async qualityURL => {
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
      const { readLiquidMarkers } = await import(qualityURL);
      let preparationInvariant;
      if (system.modules[0].constructor.name === 'FLIPSimulation') {
        const before = await readLiquidMarkers(system, renderer);
        const fluid = system.modules[0], fields = [fluid.velocityCurrentAttribute, fluid.pressureCurrentAttribute];
        const beforeFields = await Promise.all(fields.map(attribute => renderer.getArrayBufferAsync(attribute)));
        const elapsed = system._elapsedTime, sequence = system.eventRuntime._gpuEventFrameSequence;
        await system.prepare(renderer);
        const after = await readLiquidMarkers(system, renderer);
        const afterFields = await Promise.all(fields.map(attribute => renderer.getArrayBufferAsync(attribute)));
        const fieldsUnchanged = beforeFields.every((buffer, i) => {
          const before = new Uint32Array(buffer), after = new Uint32Array(afterFields[i]);
          return before.length === after.length && before.every((value, j) => value === after[j]);
        });
        preparationInvariant = {
          markersUnchanged: JSON.stringify(before) === JSON.stringify(after), fieldsUnchanged,
          timeUnchanged: elapsed === system._elapsedTime,
          eventSequenceUnchanged: sequence === system.eventRuntime._gpuEventFrameSequence,
        };
      }
      // A warm restart is distinct from ordinary following frames: reset particle state and
      // reprepare against the new bindings while retaining device/program and collider caches.
      const resetStart = performance.now();
      system.reset();
      const resetMs = performance.now() - resetStart;
      const preparing = performance.now();
      await system.prepare(renderer);
      const preparationMs = performance.now() - preparing;
      let pipelines = 0;
      const create = renderer.backend.createComputePipeline;
      renderer.backend.createComputePipeline = function (...args) {
        pipelines++; return create.apply(this, args);
      };
      const update = performance.now();
      system.advanceFrames(1, 1 / 60);
      const firstUpdateCpuMs = performance.now() - update;
      await renderer.renderAsync(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      renderer.backend.createComputePipeline = create;
      return { ...startup, backend: stats, warmFencedMs: warm, preparationInvariant,
        warmRestart: { resetMs, preparationMs, firstUpdateCpuMs,
          firstFrameFencedMs: performance.now() - update, computePipelines: pipelines } };
    }, `/@fs${path.resolve('apps/demo/benchmarks/fluids/liquidQuality.utils.js')}`);
    if (result.preparationInvariant) {
      assert(Object.values(result.preparationInvariant).every(Boolean), 'preparation must not advance live state');
      assert.equal(result.firstUsePrograms.length, 0, 'prepared FLIP must not compile on its first update');
      assert.equal(result.warmRestart.computePipelines, 0, 'prepared reset must not compile on its first update');
    }
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      await fs.writeFile(path.join(output, `${example}.cpuprofile`), JSON.stringify(profile));
    }
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
