import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';
const output = process.argv[2] ?? '/tmp/rzmps-hydrostatic'; await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' }); await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  const fixture = path.resolve(import.meta.dirname, 'fixtures/hydrostatic.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}`, errors);
  const sealed = await page.evaluate(() => window.hydrostatic(false));
  const open = await page.evaluate(() => window.hydrostatic(true));
  const markers = await page.evaluate(() => window.communicatingMarkers());
  const failures = [];
  console.log(JSON.stringify({ markers }));
  if (Math.abs(markers.sealed.reservoirLevel - markers.sealed.riserLevel) > markers.h * 1.5)
    failures.push('Marker pressure-connectivity/free-surface failure');
  if (markers.sealed.rmsSpeed > markers.h * 0.01) failures.push('Marker equilibrium velocity failure');
  if (markers.open.reservoirLevel >= markers.sealed.reservoirLevel - markers.h * 0.05)
    failures.push('Reservoir level failed to decrease');
  if (!(markers.gridOutletFlux > 1e-5) || !(markers.gridOutletVolume > markers.h ** 3 * 0.01)) {
    failures.push('Outlet grid velocity direction failure');
  }
  if (markers.open.outletMarkers <= 0) failures.push('Grid-flow / particle-flow mismatch');
  if (markers.open.rimMarkers > markers.open.outletMarkers) failures.push('Higher-rim preferential overflow');
  if (markers.sealed.belowFloor || markers.open.belowFloor) failures.push('Particle wall containment failure');
  if (sealed.profile.some((p, i, all) => i > 0 && p.reservoir + 1e-5 < all[i - 1].reservoir)
    || Math.abs(sealed.normalizedGradient - 1) > 0.25) failures.push('Pressure-profile failure');
  if (sealed.profile.some(p => Math.abs(p.reservoir - p.riser) > sealed.gravity * sealed.dt * sealed.h))
    failures.push('Pressure-connectivity failure');
  if (sealed.maxSpeed > sealed.gravity * sealed.dt * 0.02) failures.push('Equilibrium face velocity failure');
  if (Math.abs(sealed.centerFieldMaxSpeed - sealed.maxSpeed) > 1e-5)
    failures.push('Centered/face velocity reconstruction mismatch');
  if (!(open.gridOutletFlux > 1e-5)) failures.push('Pressure-connectivity/outlet-grid-flow failure');
  await fs.writeFile(path.join(output, 'result.json'),
    JSON.stringify({ sealed, open, markers, failures, errors }, null, 2));
  console.log(JSON.stringify({ sealed, open, failures }));
  assert.deepEqual(errors, []); assert.deepEqual(failures, []);
} finally { await browser?.close(); await site.close(); }
