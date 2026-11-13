import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

// Exercise the actual editor after GPU execution contexts exist, not just an uninitialized factory.
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 30000,
    args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  await page.goto(`${origin}/?preset=Volumetric%20Smoke&scene=Wind`, { waitUntil: 'networkidle0' });
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => entry.name.includes('react-three_fiber')).name;
    const { _roots } = await import(url);
    const { scene, gl } = [..._roots.values()][0].store.getState();
    let system;
    scene.traverse(object => {
      if (object.modules?.some(m => m.constructor.name === 'GasSimulation')) system = object;
    });
    window.switchFixture = { system, gl };
    gl.backend.device.lost.then(info => { throw new Error(`GPU device lost: ${info.message}`); });
  });
  await page.waitForFunction(() => window.switchFixture.system.modules[0].density.version > 100);
  for (const name of ['Checkerboard', 'Gas Flow', 'Wind', 'Gas Spatial Effects', 'Checkerboard']) {
    const before = await page.evaluate(name => {
      const select = [...document.querySelectorAll('select')]
        .find(element => [...element.options].some(option => option.text === 'Checkerboard'));
      select.value = [...select.options].find(option => option.text === name).value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return window.switchFixture.system.modules[0].density.version;
    }, name);
    await page.waitForFunction(before => window.switchFixture.system.modules[0].density.version > before + 30,
      { timeout: 20000 }, before);
    const controllers = await page.$$eval('.lil-gui .controller', elements => elements.length);
    assert(controllers < 3000, 'runtime graphs/storage must not become GUI controls');
  }
  await page.evaluate(() => window.switchFixture.gl.backend.device.queue.onSubmittedWorkDone());
  assert.deepEqual(errors, []);
  console.log('Active gas scene switching preserves editor responsiveness and GPU updates.');
} finally {
  await browser?.close();
  await site.close();
}
