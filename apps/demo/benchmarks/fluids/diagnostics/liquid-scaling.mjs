import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

// Controlled fixed-population sweep, opt-in only. Reports retain the shared union-timing convention.
const frames = Number(process.env.LIQUID_FRAMES ?? 360);
const counts = (process.env.LIQUID_COUNTS ?? '2000,5000,10000,15000,25000').split(',').map(Number);
const output = process.env.LIQUID_OUTPUT ?? '/tmp/liquid-scaling.json';
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 180000 }));
  const page = await browser.newPage(), errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/liquid-benchmark.html');
  const variants = (process.env.LIQUID_VARIANTS ?? 'final').split(',');
  const modes = {
    reference: { supportSizedBins: false, sharedMoments: false, convergedEigen: false },
    bounded: { supportSizedBins: true, sharedMoments: false, convergedEigen: false },
    early: { supportSizedBins: false, sharedMoments: false, convergedEigen: true },
    shared: { supportSizedBins: false, sharedMoments: true, convergedEigen: false },
    final: { supportSizedBins: false, sharedMoments: true, convergedEigen: true },
  };
  for (const variant of variants) for (const count of counts) {
    // Isolate resource retirement/background compilation between workloads as well as timing.
    await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
    const result = await page.evaluate(options => window.runLiquidStudy(options), {
      kind: `scaling-${count}`, frames, traceEvery: 120, detailedSurface: process.env.LIQUID_DETAIL === 'true',
      anisotropy: Number(process.env.LIQUID_ANISOTROPY ?? 0),
      kernelOptimization: process.env.LIQUID_KERNEL_OPTIONS
        ? JSON.parse(process.env.LIQUID_KERNEL_OPTIONS) : modes[variant],
    });
    results.push({ variant, count, frames, ...result });
    await fs.writeFile(output, JSON.stringify({ results, errors }, null, 2));
    console.log(JSON.stringify({ variant, count, timings: result.report.gpuStageMedianMs,
      totals: result.report.gpuExecutionMedianMs, workload: result.report.workload }));
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser?.close(); await site.close(); }
