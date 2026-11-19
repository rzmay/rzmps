import assert from 'node:assert/strict';
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
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?demoLiquid`, errors);
  const result = await page.evaluate(async ({ stagesURL, timerURL, summaryURL }) => {
    const { system, renderer, scene, camera, flip, sceneLifecycle } = window.debugFluid;
    const { profileLiquidStages } = await import(stagesURL);
    const { passTimer } = await import(timerURL);
    const { summarizeFluidTimings } = await import(summaryURL);
    const controls = {};
    sceneLifecycle.gui({ add(target, key) {
      const control = { name() { return this; }, listen() { return this; },
        onChange(callback) { this.change = callback; return this; },
        set(value) { target[key] = value; this.change?.(value); } };
      controls[key] = control; return control;
    } });
    controls.automaticTipping.set(false);
    // Fill once, then hold population fixed while comparing rigid-motion workloads.
    for (let i = 0; i < 360; i++) {
      system.advanceFrames(1, 1 / 60);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    system.stop(false);
    const surface = system.renderers[0], backend = flip.particleCollisionBackend;
    system.__liquidFixture = { flip, surface };
    const state = { stage: 'liquid/other', gpuSamples: [], cpuSubmissionMs: [] };
    const restore = profileLiquidStages(system, renderer, state);
    const timer = passTimer(renderer.backend.device, renderer.backend,
      type => type === 'render' ? 'liquid/surface rendering' : state.stage);
    const pivot = scene.getObjectByName('Teapot Tip Pivot'), origin = pivot.position.clone();
    const outcomes = [];
    for (const mode of ['static', 'translation', 'rotation', 'tipping']) {
      state.gpuSamples = []; state.cpuSubmissionMs = [];
      const before = { ...backend.stats }, topology = flip.pressureTopologyVersion;
      const fields = flip.fluidColliders.map(collider => collider.gpuField);
      if (mode === 'tipping') controls.tip.set(35);
      for (let i = 0; i < 80; i++) {
        if (mode === 'translation') pivot.position.x = origin.x + 0.06 * Math.sin(i / 40);
        if (mode === 'rotation') pivot.rotation.y = 0.1 * Math.sin(i / 40);
        if (mode === 'tipping') sceneLifecycle.update(1 / 60);
        pivot.updateWorldMatrix(true, true);
        const measured = i >= 40 && i % 4 === 0;
        if (measured) timer.start();
        const start = performance.now();
        system.advanceFrames(1, 1 / 60);
        const cpu = performance.now() - start;
        await renderer.renderAsync(scene, camera);
        await renderer.backend.device.queue.onSubmittedWorkDone();
        if (measured) { state.cpuSubmissionMs.push(cpu); state.gpuSamples.push(await timer.finish()); }
      }
      outcomes.push({ mode, ...summarizeFluidTimings(state), particles: system.liveParticleCount,
        before, after: { ...backend.stats }, topologyUpdates: flip.pressureTopologyVersion - topology,
        bakeRetained: flip.fluidColliders.every((collider, i) => collider.gpuField === fields[i]) });
    }
    timer.dispose(); restore();
    return { outcomes };
  }, Object.fromEntries([
    ['stagesURL', 'apps/demo/benchmarks/fluids/liquidStages.utils.js'],
    ['summaryURL', 'apps/demo/benchmarks/fluids/fluidProfiling.utils.js'],
    ['timerURL', 'benchmarks/lib/passTimer.js'],
  ].map(([name, file]) => [name, `/@fs${path.resolve(file)}`])));
  await fs.writeFile(process.argv[2] ?? '/tmp/liquid-teapot-motion.json',
    JSON.stringify({ ...result, errors }, null, 2));
  assert.deepEqual(errors, []);
  for (const row of result.outcomes) {
    assert.equal(row.after.fullBuilds, row.before.fullBuilds, `${row.mode}: rigid transforms rebuilt geometry`);
    assert.equal(row.after.geometryRefits, row.before.geometryRefits);
    assert(row.bakeRetained, `${row.mode}: rigid transforms rebaked occupancy`);
  }
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await site.close(); }
