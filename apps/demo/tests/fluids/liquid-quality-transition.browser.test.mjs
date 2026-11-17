import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('source-free FLIP preserves world translation and time across 2x coarsening/refinement',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 60000 }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const url = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
        path.resolve(import.meta.dirname, 'fixtures/liquid-benchmark.html')}`;
      await openFixture(page, url, errors);
      const result = await page.evaluate(() => window.runLiquidInvariant());
      console.log('FLIP quality-transition invariant:', JSON.stringify(result));
      for (const stage of result.transition.stages) {
        assert(Math.abs(stage.requestedSeconds - stage.executedSeconds - stage.skippedSeconds) < 1e-8);
        assert.equal(stage.skippedSeconds, 0, 'small fixed timesteps must all execute');
        assert.equal(stage.particleRetention, 1);
        assert(Math.abs(stage.massRetention - 1) < 1e-6);
        assert(stage.rmsTranslationError < 0.002, 'world motion must track executed time, not cell size');
        assert.equal(stage.pressure.nonFiniteSamples, 0);
        assert(stage.pressure.maxDivergenceAfterProjection < 0.01);
      }
      const [coarse, fine] = result.transition.stages;
      assert(Math.abs(coarse.toCellWidth / coarse.fromCellWidth - 2) < 1e-6);
      assert(Math.abs(fine.toCellWidth / fine.fromCellWidth - 0.5) < 1e-6);
      assert(Math.abs(result.transition.rmsWorldDisplacement - result.baseline.rmsWorldDisplacement) < 0.01);
      assert(result.transition.momentumDrift < Math.hypot(...result.transition.incomingMomentum) * 0.05);
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
