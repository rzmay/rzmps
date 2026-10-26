import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-gas-timing';
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
  const results = {};
  for (const overlay of [true, false]) for (const coarse of [true, false]) {
    const key = `${overlay ? 'overlay' : 'physical'}-${coarse ? 'coarse' : 'fine'}`;
    await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?example=gasVolume&fixedGas=true`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => window.runFrames(30));
    results[key] = await page.evaluate(async ({ overlay, coarse }) => {
      const { system, flip } = window.debugFluid;
      system.emitters.forEach(emitter => { emitter.rate = 0; emitter.rateOverDistance = 0; });
      if (!overlay) flip.renderGPU = () => {};
      const phases = { gas: [], movement: [] };
      const gas = flip.computeGPU.bind(flip);
      flip.computeGPU = (context, ...args) => { phases.gas.push(context.deltaTime); gas(context, ...args); };
      const move = system._computeGPUSimulationPhase.bind(system);
      system._computeGPUSimulationPhase = (context, ...args) => { phases.movement.push(context.deltaTime); move(context, ...args); };
      const initial = await window.runFrames(0);
      const after = await window.runFrames(coarse ? 1 : 30, coarse ? 0.5 : 1 / 60);
      const counts = { gas: phases.gas.length, movement: phases.movement.length,
        gasSeconds: phases.gas.reduce((a, b) => a + b, 0), movementSeconds: phases.movement.reduce((a, b) => a + b, 0) };
      const recovered = await window.runFrames(120);
      return { initial, after, recovered, counts };
    }, { overlay, coarse });
    await page.screenshot({ path: `${output}/${key}.png` });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${output}/metrics.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
