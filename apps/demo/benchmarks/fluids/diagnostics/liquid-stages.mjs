import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

// Explicit opt-in traces; never consumed by reported/PR benchmark selection or README generation.
const kind = process.env.LIQUID_CASE ?? 'sustained';
const frames = Number(process.env.LIQUID_FRAMES ?? 3600);
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 600000 }));
  const page = await browser.newPage(), errors = [];
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/liquid-benchmark.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const result = await page.evaluate(options => window.runLiquidStudy(options), { kind, frames, traceEvery: 120 });
  if (errors.length) throw new Error(errors.join('\n'));
  const destination = process.env.LIQUID_OUTPUT ?? `/tmp/rzmps-liquid-${kind}.json`;
  await fs.writeFile(destination, JSON.stringify(result, null, 2));
  console.log(`Liquid stage trace: ${destination}`);
} finally { await browser?.close(); await site.close(); }
