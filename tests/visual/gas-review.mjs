import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-gas-review';
const countColoredPixels = async () => {
  const { renderer, scene, camera } = window.debugFluid;
  await renderer.renderAsync(scene, camera);
  const canvas = document.createElement('canvas');
  canvas.width = renderer.domElement.width;
  canvas.height = renderer.domElement.height;
  const context = canvas.getContext('2d');
  context.drawImage(renderer.domElement, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let colored = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 12) colored++;
  }
  return colored;
};
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true,
    args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.evaluateOnNewDocument(() => {
    let seed = 173;
    Math.random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  const fixture = path.resolve(import.meta.dirname, 'fixtures/fluid.html');
  const results = {};
  for (const fixed of [true, false]) {
    const mode = fixed ? 'fixed' : 'automatic';
    await page.setViewport({ width: 800, height: 600 });
    const query = new URLSearchParams({ example: 'gasVolume', fixedGas: String(fixed) });
    if (process.env.GAS_SCENE) query.set('scene', process.env.GAS_SCENE);
    if (process.env.GAS_ADVECTION) query.set('reviewAdvection', process.env.GAS_ADVECTION);
    await page.goto(`${origin}/@fs${fixture}?${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.ready);
    results[mode] = {};
    let previous = 0;
    for (const seconds of [2, 5, 10]) {
      const started = performance.now();
      const stats = await page.evaluate(frames => window.runFrames(frames), (seconds - previous) * 60);
      stats.wallSeconds = (performance.now() - started) / 1000;
      stats.domain = await page.evaluate(() => {
        const { flip } = window.debugFluid;
        return { min: flip.bounds.min.toArray(), max: flip.bounds.max.toArray(), cellSize: flip.cellSize };
      });
      stats.coloredPixels = await page.evaluate(countColoredPixels);
      if (stats.coloredPixels < 100) throw new Error(`${mode}: gas did not produce a visible colored volume`);
      results[mode][seconds] = stats;
      await page.screenshot({ path: `${output}/${mode}-${seconds}.png` });
      previous = seconds;
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(async () => {
      const { renderer, camera, scene } = window.debugFluid;
      renderer.setSize(390, 844);
      camera.aspect = 390 / 844;
      camera.position.set(8, 6, 10);
      camera.updateProjectionMatrix();
      await renderer.renderAsync(scene, camera);
    });
    results[mode].mobileColoredPixels = await page.evaluate(countColoredPixels);
    if (results[mode].mobileColoredPixels < 100) throw new Error(`${mode}: mobile gas volume is blank`);
    await page.screenshot({ path: `${output}/${mode}-mobile.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
