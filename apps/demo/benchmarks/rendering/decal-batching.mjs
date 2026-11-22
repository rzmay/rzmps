import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { closeBrowser, withDeadline } from '../../../../scripts/process/lifecycle.utils.mjs';
import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import { openFixture } from '../../tests/fluids/openFixture.mjs';

// Focused internal measurements; raw stage traces are deliberately not part of ordinary PR output.
// This runner serves only a rendering fixture; avoid starting an unused documentation optimizer.
const demo = await createServer({ root: path.resolve('apps/demo'),
  configFile: path.resolve('apps/demo/vite.config.mjs'), server: { port: 0, host: '127.0.0.1' } });
await demo.listen(); await demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('benchmark'));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve('apps/demo/tests/rendering/fixtures/decals.html');
  const cases = [];
  for (const backend of ['webgl', 'webgpu']) {
    await openFixture(page, `http://127.0.0.1:${demo.httpServer.address().port}/@fs${fixture}?backend=${backend}`,
      errors);
    for (const count of [100, 1000, 5000, 10000]) {
      cases.push(await page.evaluate(count => window.benchmarkDecals(count), count));
    }
  }
  const warps = [];
  for (const warp of ['none', 'ray', 'anisotropic', 'combined']) {
    warps.push(await page.evaluate(warp => window.benchmarkDecals(1000, warp), warp));
  }
  const conditions = await page.evaluate(() => window.benchmarkConditions());
  const result = { cases, warps, conditions, errors,
    notes: 'Render GPU timestamps, CPU submission and fenced wall time are separate; do not add overlapping scopes. '
      + 'Anisotropic warp cost uses a fixed reconstructed principal-axis shape; no new covariance is timed.' };
  await fs.writeFile(process.argv[2] ?? '/tmp/decal-batching.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await closeBrowser(browser, 10000);
  await withDeadline(() => demo.close(), 10000, 'Closing decal benchmark server');
}

// CLI-only runner: Vite's shared catalog workers can retain idle handles after server.close().
// Results are already persisted; flush stdout after bounded resource teardown, then terminate the CLI.
await new Promise(resolve => process.stdout.write('', resolve));
process.exit(0);
