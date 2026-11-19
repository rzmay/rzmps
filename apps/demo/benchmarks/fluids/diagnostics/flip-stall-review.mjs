import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 90000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?demoLiquid`, errors);
  const result = await page.evaluate(async ({ library, spray }) => {
    const { system, renderer, scene, camera, flip, THREE, sceneLifecycle } = window.debugFluid;
    const lib = await import(library);
    const rows = [], stages = {}, device = renderer.backend.device;
    let pipelines = 0;
    for (const key of ['createComputePipeline', 'createComputePipelineAsync']) {
      const original = device[key].bind(device);
      device[key] = (...args) => { pipelines++; return original(...args); };
    }
    const compute = renderer.compute;
    renderer.compute = function (nodes, ...args) {
      const start = performance.now();
      try { return compute.call(this, nodes, ...args); } finally {
        const key = nodes.name ?? 'unnamed';
        stages[key] = Math.max(stages[key] ?? 0, performance.now() - start);
      }
    };
    let foam;
    for (let frame = 0; frame < 300; frame++) {
      if (frame === 150) {
        const surface = system.renderers[0];
        foam = new lib.ParticleSystem({ maxParticles: 6000, duration: 0, looping: true, gravityModifier: 0,
          emitters: [new lib.Emitter({ rate: 12, initialValues: {
            lifetime: [1.5, 3], scale: [0.06, 0.12], alpha: 0.22,
          } })],
          modules: [new lib.SurfaceAttachment({ surface, samplerGPU: surface.sampleSurfaceGPU,
            offset: 0.018, adhesion: 90, tangentialDrag: 2.5, detachDistance: 0.18, killOnDetach: true })],
          renderers: [new lib.SpriteRenderer(lib.Textures.Default, { alphaMap:
            spray, softParticles: true,
          materialOptions: { depthWrite: false, blending: THREE.NormalBlending } })],
        });
        const condition = lib.FLIPSimulation.FoamCondition({ minimumSpeed: 0.25,
          minimumNeighbors: 3, maximumNeighbors: 24, neighborRadius: 2 });
        condition.spatialGridOptions = { ...flip.spatialGridOptions };
        system.addSubSystem(foam, { emitContinuous: true, ratio: 0.3, inheritVelocity: 1,
          inheritScale: 0, inheritLifetime: 0, inheritAlpha: 0, inheritColor: 0, shouldEmitGPU: condition });
      }
      await new Promise(requestAnimationFrame);
      const start = performance.now(), prior = pipelines;
      sceneLifecycle.update?.(1 / 60);
      system.advanceFrames(1, 1 / 60);
      await renderer.renderAsync(scene, camera);
      const submissionMs = performance.now() - start;
      // A per-frame fence isolates execution from an unbounded queue backlog in this diagnostic.
      await device.queue.onSubmittedWorkDone();
      if (frame % 15 === 0 || submissionMs > 100) rows.push({ frame, foam: !!foam, submissionMs,
        fencedMs: performance.now() - start, newPipelines: pipelines - prior,
        bounds: [flip.bounds.min.toArray(), flip.bounds.max.toArray()], cellSize: flip.cellSize,
        particles: system.liveParticleCount, foamParticles: foam?.liveParticleCount ?? 0,
        pool: flip.workPool?.status, surfacePool: system.renderers[0].allocation?.status });
    }
    return { rows, stages, pipelines };
  }, { library: `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`,
    spray: `/@fs${path.resolve('examples/assets/images/spray_alpha.png')}` });
  await fs.writeFile('/tmp/flip-stall-review.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ rows: result.rows, pipelines: result.pipelines, errors }));
} finally { await browser?.close(); await site.close(); }
