import path from 'node:path';
import fs from 'node:fs/promises';
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
  const result = await page.evaluate(async ({ profileURL, stagesURL, timerURL, summaryURL }) => {
    const { system, renderer, scene, camera, flip, sceneLifecycle } = window.debugFluid;
    const { default: profileFrozenAnisotropicSurface } = await import(profileURL);
    const { profileLiquidStages } = await import(stagesURL);
    const { passTimer } = await import(timerURL);
    const { summarizeFluidTimings } = await import(summaryURL);
    const surface = system.renderers[0], state = { stage: 'liquid/other', gpuSamples: [], cpuSubmissionMs: [] };
    system.__liquidFixture = { flip, surface };
    const restore = profileLiquidStages(system, renderer, state), device = renderer.backend.device;
    const timer = passTimer(device, renderer.backend, type => type === 'render'
      ? 'liquid/surface rendering' : state.stage);
    const events = [];
    for (let frame = 0; frame < 600; frame++) {
      const measured = frame % 30 === 0;
      if (measured) timer.start();
      const start = performance.now();
      sceneLifecycle.update?.(1 / 60); system.advanceFrames(1, 1 / 60);
      const cpu = performance.now() - start;
      await renderer.renderAsync(scene, camera);
      // Keep a finite GPU backlog; this diagnostic distinguishes expensive execution from flooding.
      await device.queue.onSubmittedWorkDone();
      if (measured) {
        state.cpuSubmissionMs.push(cpu); state.gpuSamples.push(await timer.finish());
        events.push({ frame, cpuSubmissionMs: cpu, fencedWallMs: performance.now() - start,
          bounds: [...flip.bounds.min.toArray(), ...flip.bounds.max.toArray()], cellSize: flip.cellSize,
          particles: system.liveParticleCount, residentCapacity: flip.workGrid.capacity,
          qualityPending: !!flip.qualityPreparation, capacity: flip.workPool?.status,
          secondary: [...system.subSystems.keys()].map(child => ({ name: child.name,
            count: child.liveParticleCount })) });
      }
    }
    timer.dispose(); restore();
    const frozen = await profileFrozenAnisotropicSurface(system, renderer, scene, camera);
    await renderer.renderAsync(scene, camera);
    return { live: summarizeFluidTimings(state), events, frozen,
      surface: await surface.readSurfaceDiagnostics(), foamEnabled:
        [...system.subSystems.keys()].some(child => child.name === 'Liquid Foam') };
  }, {
    profileURL: `/@fs${path.resolve('apps/demo/benchmarks/fluids/profileFrozenAnisotropicSurface.js')}`,
    stagesURL: `/@fs${path.resolve('apps/demo/benchmarks/fluids/liquidStages.utils.js')}`,
    summaryURL: `/@fs${path.resolve('apps/demo/benchmarks/fluids/fluidProfiling.utils.js')}`,
    timerURL: `/@fs${path.resolve('benchmarks/lib/passTimer.js')}`,
  });
  await page.screenshot({ path: '/tmp/liquid-teapot-anisotropic.png' });
  await fs.writeFile('/tmp/liquid-teapot-anisotropic.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ live: result.live, frozen: result.frozen, errors }));
} finally { await browser?.close(); await site.close(); }
