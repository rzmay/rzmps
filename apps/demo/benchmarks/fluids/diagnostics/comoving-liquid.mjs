import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 120000 }));
  const page = await browser.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/comoving-liquid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  for (const mode of (process.env.LIQUID_MODES ?? 'static,translation,rotation,acceleration').split(',')) {
    const result = await page.evaluate(mode => window.runComovingLiquid(mode), mode);
    results.push(result); console.log(JSON.stringify(result));
  }
  await fs.writeFile(process.argv[2] ?? '/tmp/liquid-comoving.json', JSON.stringify({ results, errors }, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser?.close(); await site.close(); }
