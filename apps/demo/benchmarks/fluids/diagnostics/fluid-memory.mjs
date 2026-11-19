import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const replay = process.env.MEMORY_REPLAY === '1';
const controlled = process.env.MEMORY_CONTROLLED === '1';
const reference = process.env.MEMORY_REFERENCE === '1';
const output = process.argv[2] ?? '/tmp/fluid-memory';
const cases = process.env.MEMORY_PRESETS?.split(',') ?? ['flipFluid', 'volumetricSmoke', 'volumetricFire'];
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
try {
  for (const preset of cases) {
    const browser = await puppeteer.launch(browserLaunchOptions('benchmark', { protocolTimeout: 300000 }));
    try {
      const page = await browser.newPage(),
        errors = [];
      page.on('pageerror', error => errors.push(error.stack ?? error.message));
      if (replay)
        await page.evaluateOnNewDocument(() => {
          // Stable CPU identities and emission setup; GPU particle identities follow fixed step/birth counts.
          let seed = 137;
          const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
          Math.random = random;
          crypto.getRandomValues = values => {
            for (let i = 0; i < values.length; i++) values[i] = random() * 256;
            return values;
          };
        });
      const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
      await openFixture(
        page,
        `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}` +
          `?demoLiquid&reliability&memoryAttribution&measureStartup&prepareStartup&example=${preset}` +
          (replay ? '&memoryReplay' : '') +
          (controlled ? '&memoryControlled' : '') + (reference ? '&memoryReference' : ''),
        errors,
      );
      console.log(preset, 'prepared');
      const result = await page.evaluate(
        async options => {
          const { default: run } = await import(options.module);
          return run(options);
        },
        {
          module: `/@fs${path.resolve('apps/demo/benchmarks/fluids/runFluidMemoryDiagnostic.js')}`,
          seconds: Number(process.env.MEMORY_SECONDS ?? 45),
          transitions: process.env.MEMORY_TRANSITIONS !== '0',
          replay,
          controlled,
        },
      );
      const directory = path.join(output, preset);
      await fs.mkdir(directory, { recursive: true });
      const { allocations, events, samples, lifecycle, frames, ...summary } = result;
      await fs.writeFile(
        path.join(directory, 'trace.json'),
        JSON.stringify({ allocations, events, samples, lifecycle, frames }),
      );
      await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({ ...summary, errors }, null, 2));
      console.log(
        preset,
        JSON.stringify({
          steady: summary.steady.liveBytes,
          peak: summary.peak.bytes,
          coverage: summary.steady.attributedFraction,
          remainder: summary.afterDestroy.liveBytes,
          timing: summary.timing,
          unknown: summary.steady.largest.filter(resource => resource.category === 'other / unattributed'),
        }),
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await site.close();
}
