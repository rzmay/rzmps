import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-fluid-runtime';
await fs.mkdir(output, { recursive: true });
const presets = process.env.FLUID_PRESETS?.split(',') ?? ['Gas Volume', 'FLIP Fluid'];
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
// Keep a running diagnostic isolated from the checkout's build watchers.
await site.demo.watcher.close();
try {
  for (const preset of presets) {
    const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
    try {
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(120000);
      const errors = [];
      let fail;
      const failure = new Promise((_resolve, reject) => { fail = reject; });
      void failure.catch(() => {});
      page.on('pageerror', error => { errors.push(error.message); fail(error); });
      page.on('console', message => {
        if (message.text().startsWith('RUNTIME ')) console.log(message.text());
        if (message.type() === 'error') {
          console.error(message.text());
          errors.push(message.text()); fail(new Error(message.text()));
        }
      });
      const scene = process.env.FLUID_SCENE ?? (preset === 'FLIP Fluid' ? 'Fluid Teapot' : 'Checkerboard');
      const query = new URLSearchParams({ preset, scene });
      await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/?${query}`,
        { waitUntil: 'networkidle0' });
      await page.evaluate(async ({ target, library, forceResizes }) => {
        const { ParticleSystem, Benchmarks } = await import(library);
        const span = Benchmarks.prototype.span;
        let stage;
        Benchmarks.prototype.span = function (name, callback) {
          const previous = stage;
          stage = name;
          const start = performance.now();
          try { return span.call(this, name, callback); } finally {
            if (frame) frame.stages[name] = (frame.stages[name] ?? 0) + performance.now() - start;
            stage = previous;
          }
        };
        const update = ParticleSystem.prototype.update;
        const step = ParticleSystem.prototype._advanceSimulationStep;
        const nodes = new WeakSet();
        const renderers = new WeakSet();
        window.runtimeFrames = [];
        window.runtimeTarget = target;
        let frame;
        let recordedNodes;
        ParticleSystem.prototype._advanceSimulationStep = function (...args) {
          if (frame && this === window.runtimeSystem) frame.steps++;
          return step.apply(this, args);
        };
        ParticleSystem.prototype.update = function (...args) {
          if (this.isSubSystem || window.runtimeDone) return update.apply(this, args);
          window.runtimeSystem = this;
          if (forceResizes) {
            const fluid = this.modules[0];
            fluid.automaticPadding = false;
            const tick = window.runtimeFrames.length;
            if (tick > 0 && tick <= 480 && tick % 120 === 0) {
              const bounds = fluid.bounds.clone();
              const factor = tick <= 240 ? 2 : 0.5;
              bounds.min.multiplyScalar(factor);
              bounds.max.multiplyScalar(factor);
              fluid.pendingBounds = { grid: fluid.spatialGrid, bounds };
            }
          }
          const renderer = this.sceneRenderer;
          if (renderer && !renderers.has(renderer)) {
            renderers.add(renderer);
            const compute = renderer.compute;
            renderer.compute = function (node, ...rest) {
              const start = performance.now();
              const result = compute.call(this, node, ...rest);
              if (frame) {
                recordedNodes.push({ stage: stage ?? 'other', node });
                frame.dispatches += Array.isArray(node) ? node.length : 1;
                for (const item of Array.isArray(node) ? node : [node]) {
                  if (!nodes.has(item)) { nodes.add(item); frame.newNodes++; }
                }
                const ms = performance.now() - start;
                if (ms > 5) frame.slowDispatches.push({ stage, ms });
              }
              return result;
            };
          }
          recordedNodes = [];
          frame = { time: performance.now(), steps: 0, dispatches: 0, newNodes: 0, slowDispatches: [], stages: {} };
          const start = performance.now();
          try { return update.apply(this, args); } finally {
            frame.cpuMs = performance.now() - start;
            frame.particles = this.liveParticleCount;
            const fluid = this.modules[0];
            frame.bounds = fluid.bounds?.getSize({ subVectors(a, b) { return [a.x - b.x, a.y - b.y, a.z - b.z]; } });
            frame.cellSize = fluid.cellSize;
            frame.collectedColliders = fluid.collectedColliders?.size;
            frame.capacity = fluid.volumeGrid?.capacity;
            frame.growths = fluid.growthEvents;
            frame.maxVelocity = fluid.pressureStats?.maxVelocity;
            window.runtimeStageNodes = recordedNodes;
            window.runtimeFrames.push(frame);
            if (window.runtimeFrames.length % 300 === 0) console.log('RUNTIME ' + JSON.stringify({
              frame: window.runtimeFrames.length, particles: frame.particles, cpuMs: frame.cpuMs,
              interval: frame.time - window.runtimeFrames.at(-2).time, bounds: frame.bounds,
              steps: frame.steps, stages: frame.stages,
            }));
            if (window.runtimeFrames.length >= window.runtimeTarget) {
              window.runtimeDone = true;
              this.pause(false);
            }
            frame = undefined;
          }
        };
      }, { target: Number(process.env.RUNTIME_FRAMES ?? 60),
        library: `/@fs${path.resolve('packages/rzmps/build/index.mjs')}`,
        forceResizes: process.env.FORCE_RESIZES === '1' });
      await Promise.race([
        page.waitForFunction(() => window.runtimeDone, { timeout: 240000 }), failure,
      ]).catch(error => { console.error('Runtime failed:', error.message); throw error; });
      await page.screenshot({ path: path.join(output, `${preset.replaceAll(' ', '-')}.png`) });
      const result = await page.evaluate(async () => {
        const system = window.runtimeSystem;
        const fluid = system.modules[0];
        const renderer = system.sceneRenderer;
        const start = performance.now();
        await renderer.backend.device.queue.onSubmittedWorkDone();
        const backlogMs = performance.now() - start;
        const field = await fluid.getPressureProjection().readDiagnostics(renderer, fluid.velocityCurrent);
        const stages = {};
        // Replay the final dispatch sequence after pausing, fencing each group separately.
        // These are queue-fenced wall times, not hardware timestamps or additive stage costs.
        const render = renderer.render;
        renderer.render = () => {};
        try {
          for (const stage of new Set(window.runtimeStageNodes.map(item => item.stage))) {
            const nodes = window.runtimeStageNodes.filter(item => item.stage === stage).map(item => item.node);
            const samples = [];
            for (let i = 0; i < 3; i++) {
              const start = performance.now();
              for (const node of nodes) renderer.compute(node);
              await renderer.backend.device.queue.onSubmittedWorkDone();
              samples.push(performance.now() - start);
            }
            stages[stage] = samples;
          }
        } finally { renderer.render = render; }
        const surface = system.renderers.find(item => item.readSurfaceDiagnostics);
        const surfaceStats = await surface?.readSurfaceDiagnostics();
        return { frames: window.runtimeFrames, backlogMs, field, stages, surfaceStats,
          text: document.querySelector('.particle-count-monitor')?.textContent };
      });
      assert(result.frames.every(frame => frame.steps <= 4), 'fluid work must stay within its frame budget');
      assert.equal(result.field.nonFiniteSamples, 0);
      if (process.env.FORCE_RESIZES === '1') assert(
        new Set(result.frames.map(frame => frame.bounds[0])).size >= 3, 'forced bounds changes must execute');
      if (process.env.EXPECT_COLLIDERS) assert(result.frames.at(-1).collectedColliders >=
        Number(process.env.EXPECT_COLLIDERS), 'scene meshes must be discovered');
      result.errors = errors;
      await fs.writeFile(path.join(output, `${preset.replaceAll(' ', '-')}.json`), JSON.stringify(result, null, 2));
      console.log(preset, JSON.stringify({ frames: result.frames.length,
        maxSteps: Math.max(...result.frames.map(f => f.steps)),
        maxCPU: Math.max(...result.frames.map(f => f.cpuMs)),
        last: result.frames.slice(-5), stages: result.stages, surfaceStats: result.surfaceStats,
        backlogMs: result.backlogMs, field: result.field, errors }));
    } finally { await browser.close(); }
  }
} finally { await site.close(); }
