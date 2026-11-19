import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
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
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/gas-quality-physics.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const result = await page.evaluate(() => window.measureQualityPhysics());
  const sourceRatio = result.injection[1].mass / result.injection[0].mass;
  const diffusionRatio = result.diffusion[1].growth / result.diffusion[0].growth;
  const transferRatio = result.migration.after.mass / result.migration.before.mass;
  const invariants = {
    sourceMass: { expected: 1, observed: sourceRatio, passed: Math.abs(sourceRatio - 1) < 0.05 },
    worldDiffusion: { expected: 1, observed: diffusionRatio, passed: Math.abs(diffusionRatio - 1) < 0.05 },
    absoluteSource: { expected: 1 / 60, observed: result.injection[0].mass,
      passed: Math.abs(result.injection[0].mass - 1 / 60) < 1e-6 },
    sourcePhases: { passed: result.sources.every(source =>
      Math.abs(source.mass - 0.8 / 60) < 1e-6 && Math.abs(source.heat - 2.4 / 60) < 1e-6
      && source.color.every((value, i) => Math.abs(value - [0.2, 0.4, 0.8][i] * 0.8 / 60) < 1e-6)) },
    continuingSource: { passed: Math.abs(result.continuingSource.coarse.mass - 2 / 60) < 1e-6
      && Math.abs(result.continuingSource.refined.mass - 3 / 60) < 1e-6 },
    diffusionSubsteps: { passed: result.stability.substeps > 15 && result.stability.skippedSeconds === 0
      && Math.abs(result.stability.executedSeconds - 0.25) < 1e-8
      && Math.abs((result.stability.after.variance - result.stability.before.variance) / 0.15 - 1) < 0.05
      && Math.abs(result.stability.after.mass / result.stability.before.mass - 1) < 0.01 },
    transferMass: { expected: 1, observed: transferRatio, passed: Math.abs(transferRatio - 1) < 0.001 },
  };
  await fs.writeFile(process.argv[2] ?? '/tmp/gas-quality-physics.json',
    JSON.stringify({ ...result, invariants, errors }, null, 2));
  console.log(JSON.stringify({ ...result, invariants, errors }, null, 2));
  assert.deepEqual(errors, []);
  if (process.env.GAS_QUALITY_ASSERT === '1') {
    assert(Object.values(invariants).every(invariant => invariant.passed), 'Gas quality invariance is not satisfied');
  }
} finally { await browser?.close(); await site.close(); }
