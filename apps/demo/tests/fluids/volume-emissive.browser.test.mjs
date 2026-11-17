import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

test('fully emissive volume samples preserve self color and opacity independently of external light',
  { timeout: 60000 }, async () => {
    const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
    await site.demo.watcher.close();
    let browser;
    try {
      browser = await puppeteer.launch(browserLaunchOptions('test'));
      for (const backend of ['webgl', 'webgpu']) {
        const page = await browser.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const file = path.resolve(import.meta.dirname, 'fixtures/volume.html');
        await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${file}?backend=${backend}`,
          errors);
        const result = await page.evaluate(async () => {
          const { volume, red, THREE, scene } = window.volumeFixture;
          red.color = undefined;
          const light = new THREE.DirectionalLight('red', 2);
          light.position.set(0, 2, 3); scene.add(light);
          Object.assign(volume, { light, color: new THREE.Color('white'), emissive: 1,
            jitterStrength: 0, dynamicResolution: false, shadowQuality: 2 });
          const selfRed = (await window.renderVolume(['red'])).middle;
          light.color.set('blue');
          const selfBlue = (await window.renderVolume(['red'])).middle;
          volume.emissive = 0;
          const litBlue = (await window.renderVolume(['red'])).middle;
          light.color.set('red');
          const litRed = (await window.renderVolume(['red'])).middle;
          return { selfRed, selfBlue, litBlue, litRed };
        });
        assert.deepEqual(result.selfRed, result.selfBlue, `${backend}: full emissive remains self-colored`);
        assert.notDeepEqual(result.litRed, result.litBlue, `${backend}: non-emissive gas still responds to light`);
        assert.equal(result.selfRed[3], result.litRed[3], `${backend}: lighting must not change opacity`);
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally { await browser?.close(); await site.close(); }
  });
