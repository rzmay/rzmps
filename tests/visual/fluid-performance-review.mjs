import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-fluid-performance';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const results = [];
  for (const example of (process.env.PERF_EXAMPLE ? [process.env.PERF_EXAMPLE] : ['gasVolume', 'flipFluid'])) {
    for (const grid of ['2,4', '3,4', '2,5']) {
      const page = await browser.newPage();
      page.setDefaultTimeout(180000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.evaluateOnNewDocument(() => {
        let seed = 173;
        Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      });
      const query = new URLSearchParams({ example, reviewGrid: grid, fixedGas: 'true' });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      const coldStart = performance.now();
      await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?${query}`);
      await page.waitForFunction(() => window.ready);
      const readyMs = performance.now() - coldStart;
      const metrics = await page.evaluate(async cacheGrid => {
        const { system, renderer, flip, scene, camera } = window.debugFluid;
        if (cacheGrid) {
          // Diagnostic only: reuse identical build graphs, without modifying the production grid.
          const grid = flip.spatialGrid;
          const build = grid.getBuildNodes.bind(grid);
          let previousBuffers, previousKey, nodes;
          grid.getBuildNodes = buffers => {
            const key = `${grid.version}:${buffers.version}:${buffers.count}`;
            if (buffers !== previousBuffers || key !== previousKey) {
              nodes = build(buffers);
              previousBuffers = buffers;
              previousKey = key;
            }
            return nodes;
          };
        }
        const queue = renderer.backend.device.queue;
        const fence = () => queue.onSubmittedWorkDone();
        const start = performance.now();
        for (let i = 0; i < 60; i++) {
          system.advanceFrames(1, 1 / 60);
          if (i % 10 === 0) await fence();
        }
        await renderer.renderAsync(scene, camera);
        await fence();
        const warmupMs = performance.now() - start;
        const updateMs = [], updateSubmitMs = [], renderMs = [], gridMs = [], gridSubmitMs = [];
        for (let batch = 0; batch < 5; batch++) {
          await fence();
          let t = performance.now();
          for (let i = 0; i < 6; i++) system.advanceFrames(1, 1 / 60);
          updateSubmitMs.push((performance.now() - t) / 6);
          await fence();
          updateMs.push((performance.now() - t) / 6);
          t = performance.now();
          for (let i = 0; i < 6; i++) await renderer.renderAsync(scene, camera);
          await fence();
          renderMs.push((performance.now() - t) / 6);
          t = performance.now();
          for (let i = 0; i < 6; i++) flip.spatialGrid.rebuild(renderer, system._gpuBuffers, {});
          gridSubmitMs.push((performance.now() - t) / 6);
          await fence();
          gridMs.push((performance.now() - t) / 6);
        }
        const particles = await system.selectiveReadback(16000, ['position']);
        const attributes = new Set();
        for (const value of Object.values(flip)) {
          if (value?.isStorageBufferAttribute) attributes.add(value);
        }
        // Include nested gas projection and predictor/corrector attributes without counting aliases twice.
        for (const value of Object.values(flip)) {
          if (value && typeof value === 'object') {
            if (value.value?.isStorageBufferAttribute) attributes.add(value.value);
            for (const nested of Object.values(value)) {
              if (nested?.isStorageBufferAttribute) attributes.add(nested);
            }
          }
        }
        const bytes = [...attributes].reduce((total, attribute) => total + attribute.array.byteLength, 0);
        const grid = flip.spatialGrid;
        const requested = new URLSearchParams(location.search).get('reviewGrid').split(',').map(Number);
        if (flip.resolution !== 2 ** (requested[0] + requested[1])) throw new Error('Grid override was not applied');
        const gridBytes = Object.values(grid).filter(value => value?.isStorageBufferAttribute)
          .reduce((total, attribute) => total + attribute.array.byteLength, 0);
        const adapter = renderer.backend.device.adapterInfo;
        return { warmupMs, updateMs, updateSubmitMs, renderMs, gridMs, gridSubmitMs, bytes, gridBytes,
          count: particles.filter(({ particle }) => particle.alive).length,
          resolution: flip.resolution, cellSize: flip.cellSize, pressureIterations: flip.pressureIterations,
          min: flip.bounds.min.toArray(), max: flip.bounds.max.toArray(),
          adapter: adapter ? { vendor: adapter.vendor, architecture: adapter.architecture,
            device: adapter.device, description: adapter.description } : null };
      }, process.env.PERF_CACHE_GRID === 'true');
      if (errors.length) throw new Error(errors.join('\n'));
      results.push({ example, grid, cacheGrid: process.env.PERF_CACHE_GRID === 'true', readyMs, ...metrics });
      console.log(JSON.stringify(results.at(-1)));
      await fs.writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
      await page.screenshot({ path: `${output}/${example}-${grid.replace(',', '-')}.png` });
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await site.close();
}
