import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?demoLiquid&profile=true`);
  await page.waitForFunction(() => window.ready);
  const result = await page.evaluate(async () => {
    const { system, renderer, flip, sceneLifecycle } = window.debugFluid;
    for (let i = 0; i < 900; i++) {
      system.advanceFrames(1, 1 / 60);
      await renderer.resolveTimestampsAsync('compute');
    }
    system.stop(false);
    const before = { ...flip.particleCollisionBackend.stats };
    let tip;
    sceneLifecycle.gui({ add(target, key) {
      const control = { name() { return this; }, listen() { return this; },
        onChange(fn) { this.change = fn; return this; } };
      if (key === 'tip') tip = value => { target.tip = value; control.change?.(value); };
      return control;
    } });
    const compute = renderer.compute, timestampUID = renderer.backend.getTimestampUID;
    let stage = 'other', sequence = 0, records = [];
    renderer.compute = function (node, ...args) {
      const previous = stage;
      stage = node === flip.movingWallsNode ? 'movingWall' : node === flip.solidNode ? 'solid' : 'other';
      try { return compute.call(this, node, ...args); } finally { stage = previous; }
    };
    renderer.backend.getTimestampUID = function (...args) {
      const uid = timestampUID.apply(this, args).replace(/:f(\d+)$/, `-pass${sequence++}:f$1`);
      records.push({ uid, stage });
      return uid;
    };
    const outcomes = [];
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const moving of [false, true]) {
      const samples = [];
      for (let i = 0; i < 40; i++) {
        records = [];
        sequence = 0;
        if (moving) tip((i + 1) * 0.25);
        sceneLifecycle.update(1 / 60);
        const start = performance.now();
        system.advanceFrames(1, 1 / 60);
        const cpuMs = performance.now() - start;
        const totalMs = await renderer.resolveTimestampsAsync('compute');
        if (i >= 10) {
          const times = renderer.backend.timestampQueryPool.compute.timestamps;
          const duration = name => records.filter(record => record.stage === name)
            .reduce((sum, record) => sum + (times.get(record.uid) ?? 0), 0);
          samples.push({ totalMs, cpuMs, movingWallMs: duration('movingWall'), solidMs: duration('solid') });
        }
      }
      outcomes.push({ moving, ...Object.fromEntries(Object.keys(samples[0])
        .map(key => [key, median(samples.map(sample => sample[key]))])) });
    }
    renderer.compute = compute;
    renderer.backend.getTimestampUID = timestampUID;
    return { outcomes, before, after: { ...flip.particleCollisionBackend.stats } };
  });
  assert.deepEqual(errors, []);
  assert.equal(result.before.fullBuilds, result.after.fullBuilds);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await site.close(); }
