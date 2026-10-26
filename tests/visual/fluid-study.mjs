import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

// Manual diagnostic, not a timing-sensitive regression test.
const output = process.argv[2] ?? '/tmp/rzmps-fluid-study';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
const browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => { throw error; });
  page.on('console', message => {
    if (message.type() === 'error') throw new Error(message.text());
  });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
  const results = {};
  const open = async example => {
    await page.goto(`${origin}/@fs${fixture}?example=${example}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.ready);
  };
  await open('gasBlenderSmoke');
  await page.evaluate(() => window.runFrames(30));
  for (const mode of ['smooth', 'checkerboard']) {
    for (const iterations of [0, 16, 64]) {
      results[`projection-${mode}-${iterations}`] = await page.evaluate(async ({ iterations, mode }) => {
        await window.projectGas(iterations, mode);
        return window.lastProjectionMetrics;
      }, { iterations, mode });
    }
  }
  for (const limit of [16, null]) {
    await open('flipFluid');
    await page.evaluate(limit => { window.debugFluid.flip.maxBounds = limit ?? Infinity; }, limit);
    await page.evaluate(() => window.runFrames(300));
    await page.evaluate(() => window.moveParticle([30, 0, 0], [1, 0, 0]));
    await new Promise(resolve => setTimeout(resolve, 550));
    await page.evaluate(() => window.runFrames(1));
    await new Promise(resolve => setTimeout(resolve, 100));
    const stats = await page.evaluate(() => window.runFrames(120));
    stats.bounds = await page.evaluate(() => window.debugFluid.flip.bounds.getSize({
      subVectors(a, b) { return [a.x - b.x, a.y - b.y, a.z - b.z]; },
    }));
    results[`flip-limit-${limit ?? 'unlimited'}`] = stats;
  }
  for (const strength of [0, 0.2, 2]) {
    await open('gasBlenderSmoke');
    await page.evaluate(() => window.runFrames(30));
    await page.evaluate(strength => {
      window.seedGas();
      window.debugFluid.flip.vorticityStrength = strength;
    }, strength);
    const initial = await page.evaluate(() => window.runFrames(1));
    const after = await page.evaluate(() => window.runFrames(120));
    results[`curl-${strength}`] = { initial, after };
    await page.screenshot({ path: `${output}/curl-${strength}.png` });
  }
  for (const scenario of ['normal', 'large-step', 'no-confinement', 'no-source-velocity']) {
    await open('gasVolume');
    await page.evaluate(scenario => {
      const gas = window.debugFluid.flip;
      if (scenario === 'no-confinement') gas.vorticityStrength = 0;
      if (scenario === 'no-source-velocity') gas.velocitySourceStrength = 0;
    }, scenario);
    const initial = await page.evaluate(() => window.runFrames(300));
    if (scenario === 'large-step') await page.evaluate(() => window.runFrames(1, 0.5));
    const after = await page.evaluate(frames => window.runFrames(frames), scenario === 'large-step' ? 90 : 120);
    results[scenario] = { initial, after };
    await page.screenshot({ path: `${output}/${scenario}.png` });
  }
  await fs.writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  await site.close();
}
