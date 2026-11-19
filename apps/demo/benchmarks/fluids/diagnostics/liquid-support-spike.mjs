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
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic'));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const file = path.resolve('apps/demo/tests/fluids/fixtures/liquid-activity.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${file}`, errors);
  const result = await page.evaluate(async () => ({ support: await window.traceSupportActivity(),
    moving: await window.traceMovingQuery() }));
  await fs.writeFile(process.env.LIQUID_OUTPUT ?? '/tmp/liquid-support-spike.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ support: result.support, errors }));
} finally { await browser?.close(); await site.close(); }
