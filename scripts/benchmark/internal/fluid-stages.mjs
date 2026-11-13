// Opt-in diagnostic measurements only. This runner never updates README/PR benchmark artifacts.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';
import { openFixture } from '../../tests/preview/fluids/openFixture.mjs';

const { values } = parseArgs({ options: {
  samples: { type: 'string', default: '3' },
  case: { type: 'string', default: 'all' },
  output: { type: 'string' },
} });
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20) throw new Error('--samples must be 1–20');
if (!['all', 'startup', 'colliders', 'effects'].includes(values.case)) throw new Error('Unknown --case');
const selected = name => values.case === 'all' || values.case === name;
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
const results = { schema: 1, internal: true, samples, environment: {}, cases: [] };
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 120000,
    args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  const fixtures = path.resolve(import.meta.dirname, '../../tests/preview/fluids/fixtures');
  const run = async (name, file, query, measure) => {
    const observations = [];
    for (let sample = 0; sample < samples; sample++) {
      // A new page isolates live resources. Later samples may benefit from the driver's pipeline cache.
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.stack ?? error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        page.setDefaultTimeout(60000);
        await openFixture(page, `${origin}/@fs${file}?${query}`, errors);
        observations.push(await page.evaluate(measure));
        assert.deepEqual(errors, [], `${name}: browser/GPU errors`);
      } finally { await page.close(); }
    }
    results.cases.push({ name, observations });
  };

  if (selected('startup')) for (const example of ['volumetricSmoke', 'volumetricFire']) {
    await run(`startup:${example}`, path.join(fixtures, 'fluid.html'),
      `example=${example}&measureStartup&prepareStartup&profile`, () => {
        const result = window.fluidStartup;
        if (!(result.firstPopulatedFrameMs > 0)) throw new Error('Startup measurements missing');
        return result;
      });
  }
  if (selected('colliders')) {
    await run('fluid-collider-baking', path.join(fixtures, 'fluid-collider.html'), '', async () => {
      const model = '/@fs' + location.pathname.split('/@fs')[1].split('/scripts/')[0]
        + '/examples/assets/models/utah_teapot_quad.obj';
      const shapes = [];
      for (const shape of ['box', 'sphere', 'teapot']) shapes.push(await window.bake(shape, model));
      const reuse = await window.sharedFluidSystems();
      if (!reuse.shared || shapes.some(shape => !shape.occupied)) throw new Error('Invalid collider bake');
      return { shapes, reuse };
    });
  }
  if (selected('effects')) {
    await run('spatial-effect-baking', path.join(import.meta.dirname, 'spatial-bake.html'), '',
      () => window.benchmarkSpatialBake());
  }
  results.environment = { browser: await browser.version(),
    note: 'Fenced elapsed times include queue completion; CPU submissions and compilation are reported separately.' };
  const json = JSON.stringify(results, null, 2) + '\n';
  if (values.output) await writeFile(values.output, json);
  else process.stdout.write(json);
} finally {
  await browser?.close();
  await site.close();
}
