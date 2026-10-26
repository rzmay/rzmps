import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-flip-review';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true,
    args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.ready);
  const results = {};
  let previous = 0;
  for (const seconds of [15, 30, 50]) {
    results[seconds] = await page.evaluate(async frames => ({
      ...await window.runFrames(frames), packing: await window.fluidPacking(),
    }), (seconds - previous) * 60);
    await page.screenshot({ path: `${output}/${seconds}.png` });
    previous = seconds;
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
