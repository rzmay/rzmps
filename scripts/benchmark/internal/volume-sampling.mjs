// Internal frozen-field comparison; measurements and images never update public benchmark reports.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';
import { openFixture } from '../../tests/preview/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [], result = [];
  await page.setViewport({ width: 800, height: 600 });
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('scripts/tests/preview/fluids/fixtures/fluid.html');
  for (const preset of ['volumetricSmoke', 'volumetricFire']) {
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`
      + `?example=${preset}`, errors, { timeout: 30000 });
    const measurement = await page.evaluate(async () => {
      const { measureVolumeSampling } = await import('./measureVolumeSampling.js');
      return measureVolumeSampling();
    });
    for (const row of measurement.rows) {
      const image = Buffer.from(row.image.split(',')[1], 'base64');
      await fs.writeFile(`/tmp/volume-sampling-${preset}-${row.name}.png`, image);
      delete row.image;
    }
    result.push({ preset, ...measurement });
    console.log(preset, measurement.rows);
  }
  await fs.writeFile('/tmp/volume-sampling.json', JSON.stringify({ result, errors }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser?.close(); await site.close(); }
