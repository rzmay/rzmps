import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('source masks preserve exhaustive gathers, transient attributes and source death',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    let browser;
    try {
      browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
      await page.goto(`${origin}/@fs${fixture}?example=gasVolume&fixedGas=true&reviewGrid=2,4`,
        { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready);
      const results = await page.evaluate(async () => {
        const { flip: gas, system, THREE, renderer } = window.debugFluid;
        gas.tags = ['source'];
        gas.densityCutoff = 1e-8;
        system.emitters[0].tags = ['source', 'other'];
        await window.runFrames(1);
        const included = system.getGPUFilterTagMask(['source']);
        const excluded = system.getGPUFilterTagMask(['other']);
        for (const module of system.modules) {
          if (module.constructor.name === 'ScaleOverLifetime') module.options.scale = new THREE.Vector3(1.8, 0.8, 1.3);
          if (module.constructor.name === 'ColorOverLifetime') {
            module.options.color = new THREE.Color(0.6, 0.4, 0.8);
            module.options.alpha = 0.35;
          }
        }
        const samples = [
          { position: [0.97, 0.1, -0.2], scale: [0.4, 0.2, 0.6], color: [1, 0.2, 0.4], alpha: 0.8,
            velocity: [0.2, 0.4, -0.1] },
          { position: [1.01, 0.2, -0.1], scale: [2.8, 0.8, 1.4], color: [0.2, 0.8, 1], alpha: 0.3 },
          { position: [-2.05, -0.9, 1.1], scale: [1.8, 0.3, 1.1], color: [0.8, 0.5, 0.1], alpha: 0.6 },
          { position: [7.8, -0.1, 0.1], scale: [1.2, 1.2, 1.2], color: [0.3, 0.8, 0.6], alpha: 0.4 },
          { position: [3.2, 0.3, -1.1], scale: [3, 2, 1], color: [1, 0, 0], alpha: 1, tagMask: excluded },
        ].map(sample => ({ tagMask: included, ...sample }));
        const grid = gas.volumeGrid;
        const sourceActive = grid.sourceActive;
        const outcomes = [];
        let markedTiles = 0;
        for (const method of ['SemiLagrangian', 'MacCormack']) {
          gas.advectionMethod = method;
          const states = [];
          for (const masked of [true, false]) {
            grid.sourceActive = masked ? sourceActive : index => grid.active(index);
            gas.gpuCacheKey = '';
            gas.visualCacheKey = '';
            window.seedGasSourceSamples(samples);
            gas.velocitySourceStrength = 0.6;
            await window.runFrames(1, 0.01);
            states.push(await window.readGasSourceState());
            if (masked) {
              const metadata = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
              markedTiles = 0;
              for (let word of metadata.subarray(grid.sourceMaskOffset)) {
                while (word) { markedTiles++; word = (word & (word - 1)) >>> 0; }
              }
            }
          }
          const errors = {};
          for (const key of Object.keys(states[0])) {
            let error = 0, amount = 0;
            for (let i = 0; i < states[0][key].length; i++) {
              error = Math.max(error, Math.abs(states[0][key][i] - states[1][key][i]));
              amount += Math.abs(states[0][key][i]);
            }
            errors[key] = { error, amount };
          }
          outcomes.push({ method, errors });
        }
        grid.sourceActive = sourceActive;
        gas.gpuCacheKey = '';
        gas.visualCacheKey = '';
        window.stopGasSources();
        const retained = await window.runFrames(1, 0.01);
        const afterDeath = await window.readGasSourceState();
        const mask = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute))
          .subarray(grid.sourceMaskOffset);
        let stale = 0;
        for (const value of afterDeath.visual) stale = Math.max(stale, Math.abs(value));
        return { outcomes, retained: retained.field.sum, stale, maskEmpty: mask.every(value => value === 0),
          markedTiles, totalTiles: grid.sourceTileSide ** 3,
          storageBufferLimit: renderer.backend.device.limits.maxStorageBuffersPerShaderStage };
      });
      console.log('Masked gas gathers:', JSON.stringify(results));
      for (const outcome of results.outcomes) for (const [field, result] of Object.entries(outcome.errors)) {
        assert.ok(result.error < 1e-6, `${outcome.method}: masked ${field} differs from exhaustive gathering`);
        assert.ok(result.amount > 0, `${field} must have a nonzero test signal`);
      }
      assert.ok(results.retained > 0, 'source masking must not erase previously emitted gas');
      assert.equal(results.stale, 0, 'dead sources must not leave transient visual contributions');
      assert.equal(results.maskEmpty, true, 'source occupancy must clear when sources die');
      assert.ok(results.markedTiles > 0 && results.markedTiles < results.totalTiles / 4,
        'source marking should cover a small subset of the logical domain');
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await site.close();
    }
  });
