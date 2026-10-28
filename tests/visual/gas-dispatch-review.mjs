import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-gas-dispatch';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const results = [];
  for (const [grid, budget, method] of [
    ['2,4', 32, 'SemiLagrangian'], ['2,4', 64, 'SemiLagrangian'],
    ['3,4', 64, 'SemiLagrangian'], ['3,4', 512, 'SemiLagrangian'], ['2,4', 64, 'MacCormack'],
  ]) {
    const states = [];
    for (const mode of ['pool', 'active']) {
      const page = await browser.newPage();
      page.setDefaultTimeout(120000);
      const errors = [];
      let measuring = false;
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      page.on('framenavigated', frame => {
        if (measuring && frame === page.mainFrame()) errors.push('Page reloaded during measurement');
      });
      await page.evaluateOnNewDocument(() => {
        let seed = 173;
        Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      });
      const query = new URLSearchParams({ example: 'gasVolume', fixedGas: 'true', profile: 'true',
        reviewGrid: grid, reviewBricks: String(budget), reviewDispatch: mode, reviewAdvection: method });
      await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
        path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?${query}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready).catch(error => {
        throw new Error(`${error.message}\n${errors.join('\n')}`);
      });
      measuring = true;
      const result = await page.evaluate(async () => {
        const { flip: gas, renderer, system, gpu } = window.debugFluid;
        const { Fn, vec4 } = gpu;
        window.seedGasSourceSamples([{ position: [0.1, 0.2, 0.1], velocity: [0.4, 0.6, 0],
          scale: [0.5, 0.5, 0.5], color: [0.2, 0.4, 0.8], alpha: 1 }]);
        renderer.compute(Fn(() => {
          const particle = system._gpuBuffers.storage.createParticle(undefined, true);
          particle.lifetime.assign(100);
          system._gpuBuffers.storage.storeParticle(particle);
        })().compute(system._gpuBuffers.count));
        gas.velocitySourceStrength = 0.6;
        gas.buoyancy = 1;
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const fence = () => renderer.backend.device.queue.onSubmittedWorkDone();
        const update = async () => {
          await fence();
          const start = performance.now();
          system.advanceFrames(1, 1 / 60);
          const submit = performance.now() - start;
          await fence();
          const wall = performance.now() - start;
          const gpuMs = await renderer.resolveTimestampsAsync('compute');
          return { submit, wall, gpuMs };
        };
        const startup = [];
        for (let frame = 0; frame < 5; frame++) startup.push(await update());
        for (let frame = 0; frame < 55; frame++) await update();
        const samples = [];
        for (let frame = 0; frame < 12; frame++) samples.push(await update());
        const fields = await window.readGasSourceState();
        // Preserve every nonzero entry without serializing millions of empty voxels.
        const state = Object.fromEntries(Object.entries(fields).map(([key, field]) => {
          const entries = [];
          for (let i = 0; i < field.length; i++) if (field[i] !== 0) entries.push(i, field[i]);
          return [key, entries];
        }));
        const allocation = await gas.readGridDiagnostics(renderer);
        // Matched frozen-state microbenchmarks isolate launch/clear costs from evolving gas.
        const scratch = new gpu.StorageBufferAttribute(new Float32Array(gas.cellCount * 4), 4);
        const values = gpu.storage(scratch, 'vec4', gas.cellCount);
        const kernel = gas.computeCells(index => { values.element(index).assign(vec4(index.add(1))); });
        const measure = async callback => {
          callback();
          await fence();
          await renderer.resolveTimestampsAsync('compute');
          const times = [];
          for (let batch = 0; batch < 7; batch++) {
            await fence();
            const start = performance.now();
            for (let repeat = 0; repeat < 8; repeat++) callback();
            await fence();
            times.push((performance.now() - start) / 8);
            await renderer.resolveTimestampsAsync('compute');
          }
          return median(times);
        };
        const cellDispatchMs = await measure(() => renderer.compute(kernel));
        const clearMs = await measure(() => gas.clearNewBricks(renderer));
        const args = [];
        for (const attribute of gas.volumeGrid.dispatchAttributes) {
          args.push([...new Uint32Array(await renderer.getArrayBufferAsync(attribute))]);
        }
        scratch.dispose();
        return { state, allocation, args, cellDispatchMs, clearMs, clearPasses: gas.clearNewNodes.length,
          startup: startup.map(({ wall, gpuMs }) => ({ wall, gpuMs })),
          steady: Object.fromEntries(['submit', 'wall', 'gpuMs'].map(key => [key, median(samples.map(s => s[key]))])),
          storageLimit: renderer.backend.device.limits.maxStorageBuffersPerShaderStage };
      });
      assert.deepEqual(errors, []);
      assert.equal(result.allocation.overflowedBricks, 0);
      assert.equal(result.storageLimit, 8);
      states.push(result.state);
      delete result.state;
      results.push({ grid, budget, method, mode, ...result });
      console.log(JSON.stringify(results.at(-1)));
      await page.close();
    }
    for (const key of Object.keys(states[0])) {
      assert.equal(states[0][key].length, states[1][key].length);
      let difference = 0;
      for (let i = 0; i < states[0][key].length; i++) {
        assert(Number.isFinite(states[1][key][i]));
        difference = Math.max(difference, Math.abs(states[0][key][i] - states[1][key][i]));
      }
      assert(difference < 1e-5, `${grid}/${budget}/${method}: ${key} differs by ${difference}`);
    }
  }
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
