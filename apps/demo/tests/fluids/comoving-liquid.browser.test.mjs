import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('moving liquid walls preserve comoving translation and acceleration without frame-induced shear',
  { timeout: 90000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 60000 }));
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      const fixture = path.resolve(import.meta.dirname, 'fixtures/comoving-liquid.html');
      await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
      for (const mode of ['static', 'translation', 'rotation', 'acceleration']) {
        const result = await page.evaluate(mode => window.runComovingLiquid(mode), mode);
        console.log('Comoving contacts:', JSON.stringify(result));
        assert.equal(result.final.particles, result.initial.particles);
        assert.equal(result.final.mass, result.initial.mass);
        assert.equal(result.pressure.nonFiniteSamples, 0);
        assert(result.pressure.maxDivergenceAfterProjection < 0.005);
        assert.equal(result.after.fullBuilds, result.before.fullBuilds);
        assert.equal(result.after.geometryRefits, result.before.geometryRefits);
        assert(result.maxPenetration < 0.001);
        assert.equal(result.surface.overflowedBricks, 0);
        assert.equal(result.surface.overflowedTriangles, 0);
        if (mode !== 'rotation') {
          assert.equal(result.wall.wrongXFaces, 0, 'closed faces must follow the translating wall');
          assert(result.rmsComovingDisplacement < 0.002);
          assert(result.rmsContactDisplacement < 0.002);
          assert(result.rmsVelocityError < 0.01);
        } else {
          // A finite free surface is not forced into exact solid-body rotation.
          assert(result.rmsComovingDisplacement < 0.02);
          assert(result.rmsVelocityError < 0.05);
        }
      }
      assert.deepEqual(errors, []);
    } finally { await browser?.close(); await site.close(); }
  });
