import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { headless: true, args: [...browserLaunchOptions('diagnostic').args, '--enable-unsafe-webgpu'] }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') { errors.push(e.text()); console.error(e.text()); } });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid-collider.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  for (const shape of ['box', 'sphere', 'plane', 'teapot']) {
    const model = `/@fs${path.resolve('examples/assets/models/utah_teapot_quad.obj')}`;
    const result = await page.evaluate(({ shape, model }) => window.bake(shape, model), { shape, model });
    console.log(JSON.stringify(result));
    assert(result.occupied > 0);
    assert(result.shared && result.rigidReuse && result.cachedUpload && result.invalidated);
    assert(result.values.every(value => value === 0 || value === 1));
    if (shape !== 'teapot') assert.equal(result.center, 1);
    if (shape === 'plane') assert(result.occupied < 16 ** 3, 'shell must not fill the expanded field corners');
  }
  const systems = await page.evaluate(() => window.sharedFluidSystems());
  console.log('Shared fluid systems:', JSON.stringify(systems));
  assert(systems.shared, 'separate simulation lifetimes must reuse the same unchanged geometry bake');
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
