import { browserLaunchOptions } from '../../../../scripts/browser/launch.utils.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../../scripts/site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('test', { protocolTimeout: 90000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve(import.meta.dirname, 'fixtures/hydrostatic.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  // The shared fixture explicitly decodes sparse cell/face addresses; dense offsets are not pool addresses.
  const sealed = await page.evaluate(() => window.hydrostatic(false));
  const open = await page.evaluate(() => window.hydrostatic(true));
  const markers = await page.evaluate(() => window.communicatingMarkers());
  console.log('Liquid hydrostatic projection:', JSON.stringify({ sealed, open, markers }));
  assert(Math.abs(sealed.normalizedGradient - 1) < 0.25, 'gravity must establish hydrostatic pressure');
  assert(sealed.maxSpeed < sealed.gravity * sealed.dt * 0.02, 'closed liquid must remain pressure-supported');
  assert(Math.abs(sealed.centerFieldMaxSpeed - sealed.maxSpeed) < 1e-5);
  assert(sealed.stats.maxDivergenceAfterProjection < 0.002);
  assert(sealed.profile.every(row => Math.abs(row.reservoir - row.riser) < sealed.gravity * sealed.dt * sealed.h));
  assert(open.gridOutletFlux > 1e-5, 'opening the lower outlet must generate positive discharge');
  assert.equal(markers.sealed.count, markers.initial.count);
  assert.equal(markers.open.count, markers.initial.count);
  assert(Math.abs(markers.sealed.reservoirLevel - markers.sealed.riserLevel) < markers.h * 1.5);
  assert(markers.sealed.rmsSpeed < markers.h * 0.01);
  assert(markers.open.outletMarkers > 0 && markers.gridOutletFlux > 1e-5);
  assert.equal(markers.sealed.belowFloor, 0); assert.equal(markers.open.belowFloor, 0);
  assert.equal(sealed.stats.nonFiniteSamples, 0); assert.equal(open.stats.nonFiniteSamples, 0);
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
