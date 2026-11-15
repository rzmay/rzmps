/* global window */
// Controlled single-step replay. Does not rebuild or modify the library bundle.
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../site/dev.mjs';
import { openFixture } from '../../tests/preview/fluids/openFixture.mjs';

const output = path.resolve(process.argv[2] ?? '/tmp/rzmps-volume-quality.json');
const examples = (process.env.EXAMPLES ?? 'volumetricSmoke,volumetricFire').split(',');
if (examples.some(name => !['volumetricSmoke', 'volumetricFire'].includes(name))) {
  throw new Error('EXAMPLES must contain volumetricSmoke and/or volumetricFire.');
}
const warmup = Number(process.env.WARMUP ?? 5), samples = Number(process.env.SAMPLES ?? 12);
const stageAudit = process.env.STAGE_AUDIT === '1';
if (![warmup, samples].every(n => Number.isSafeInteger(n) && n > 0 && n <= 30)) {
  throw new Error('WARMUP and SAMPLES must be integers in [1,30].');
}
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
const results = [];
try {
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 180000,
    args: ['--enable-unsafe-webgpu'] });
  for (const example of examples) {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.evaluateOnNewDocument(() => {
      let seed = 173;
      Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    });
    const fixture = path.resolve(import.meta.dirname, '../../tests/preview/fluids/fixtures/fluid.html');
    const helper = path.resolve(import.meta.dirname, '../../tests/preview/fluids/fixtures/volume-quality.js');
    try {
      const query = new URLSearchParams({ example, profile: 'true', prepareStartup: 'true',
        measureStartup: 'true' });
      await openFixture(page,
        `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?${query}`,
        errors, { timeout: 120000 });
      await page.addScriptTag({ type: 'module', url: `/@fs${helper}` });
      await page.waitForFunction(() => typeof window.runVolumeQuality === 'function');
      console.log(`${example}: ${stageAudit ? 'fixed-quality stage census at update 50' : 'quality A/B replays'}`);
      const observation = await page.evaluate(options => window.runVolumeQuality(options),
        { warmup, samples, stageAudit });
      results.push({ example, observation, errors });
    } catch (error) { results.push({ example, error: error.stack, errors }); }
    finally { await page.close(); }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(results, null, 2));
    console.log(`${example}: recorded ${output}`);
  }
} finally { await browser?.close(); await site.close(); }
if (results.some(result => result.error || result.errors.length || !result.observation?.valid)) process.exitCode = 1;
