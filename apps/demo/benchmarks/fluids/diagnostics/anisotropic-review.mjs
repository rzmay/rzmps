import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 180000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/liquid-benchmark.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const result = await page.evaluate(() => window.profileFrozenAnisotropy());
  await fs.writeFile('/tmp/liquid-anisotropic-frozen.json', JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await site.close(); }
