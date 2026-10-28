import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?example=gasVolume&fixedGas=true`);
  await page.waitForFunction(() => window.ready);
  for (const directory of ['/src/gui', '/src/gui/particle-system-gui']) {
    const controls = await page.evaluate(async directory => {
      const { ModuleGUI } = await import(`${directory}/ModuleGUI.js`);
      const { RendererGUI } = await import(`${directory}/RendererGUI.js`);
      const { ParticleSystemSerializer } = await import(`${directory}/ParticleSystemSerializer.js`);
      const { flip, system } = window.debugFluid;
      flip.runtimeDataForOtherModules = 42;
      const exposed = [];
      const controller = { name() { return this; }, disable() { return this; }, listen() { return this; },
        onChange() { return this; } };
      const folder = { add(_owner, key) { exposed.push(key); return controller; },
        addFolder() { return this; }, close() { return this; } };
      const context = { addTags() {}, addObject() {}, prettyName: key => key, emitCode() {},
        addValue(_folder, _owner, key) { exposed.push(key); } };
      ModuleGUI.prototype.buildModule.call(context, folder, flip, system);
      const module = [...exposed];
      exposed.length = 0;
      RendererGUI.prototype.buildRenderer.call(context, folder, system.renderers[0], system);
      const serialized = new ParticleSystemSerializer({ system }).serializeRenderer(system.renderers[0]);
      return { module, renderer: exposed, serialized };
    }, directory);
    for (const key of ['pressureIterations', 'maxActiveBricks', 'advectionMethod', 'brickSubdivisions']) {
      assert(controls.module.includes(key), `${directory}: missing tuning control ${key}`);
    }
    for (const key of ['runtimeDataForOtherModules', 'volumeGrid', 'velocityCurrent', 'maxima', 'useSpatialGrid']) {
      assert(!controls.module.includes(key), `${directory}: internal ${key} leaked into GUI`);
    }
    assert(controls.renderer.includes('noiseStrength'));
    assert(controls.renderer.includes('noiseContrast'));
    assert(controls.serialized.includes('noiseContrast:'));
    assert(controls.renderer.includes('steps'));
    for (const key of ['adaptiveStepping', 'adaptiveStepThreshold', 'adaptiveStepFactor',
      'transmittanceThreshold', 'sceneDepthClipping', 'sceneDepthBias']) {
      assert(controls.renderer.includes(key), `${directory}: missing ray control ${key}`);
      assert(controls.serialized.includes(`${key}:`), `${directory}: missing serialized ray control ${key}`);
    }
    assert(!controls.renderer.includes('field'));
    assert(!controls.renderer.includes('bindings'));
  }
  console.log('Fluid and volume GUI exposes tuning parameters only.');
} finally {
  await browser?.close();
  await site.close();
}
