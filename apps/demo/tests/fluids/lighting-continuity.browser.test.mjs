import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('lighting remains continuous across cascade shells, finite light ranges and domain changes',
  { timeout: 120000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { headless: true, args: [...browserLaunchOptions('test').args, '--enable-unsafe-webgpu'] }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/lighting-grid.html');
      const base = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
      await openFixture(page, `${base}/@fs${fixture}`, errors);
      const result = await page.evaluate(async options => {
        const { measureLightingContinuity } = await import('./measureLightingContinuity.js');
        return measureLightingContinuity(options);
      }, { extent: Number(process.env.LIGHTING_EXTENT ?? 1), frameCount: Number(process.env.LIGHTING_FRAMES ?? 32),
        width: Number(process.env.LIGHTING_WIDTH ?? 400), pixelRatio: Number(process.env.LIGHTING_DPR ?? 1) });
      const features = process.env.LIGHTING_FEATURES ? await page.evaluate(async () => {
        const { measureVolumeFeatures } = await import('./measureLightingContinuity.js');
        return measureVolumeFeatures();
      }) : [];
      await fs.writeFile('/tmp/lighting-continuity.json', JSON.stringify({ result, features, errors }, null, 2));
      console.log(result.map(({ name, maxDomainChange, maxOracleError, maxTemporalChange,
        medianComputeGPUms, medianRenderGPUms, outsideRange }) => ({ name, maxDomainChange, maxOracleError,
        maxTemporalChange, medianComputeGPUms, medianRenderGPUms, outsideRange })));
      assert.deepEqual(errors, []);
      assert(result.every(item => item.pipelines === 0), 'moving lights reuse all prepared compute pipelines');
      const higher = result.find(item => item.name === 'higher');
      assert(higher.outsideRange > 0 && higher.distant > 0, 'an admitted light has no hard local range cutoff');
      assert(higher.maxDomainChange < 0.02, 'empty domain growth must not slide the lighting lattice');
      assert(higher.maxOracleError < 0.25, 'point-light shell transfers preserve vacuum attenuation');
      assert(higher.maxTemporalChange < 0.02, 'moving lights must not produce abrupt whole-volume jumps');
      assert(higher.frames.every(frame => frame.pixelRMSE < 6 && frame.maximumPixelDelta < 64),
        'moving-light images remain locally continuous, not merely constant in average brightness');
    } finally { await browser?.close(); await site.close(); }
  });
