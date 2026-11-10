import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') {
      errors.push(message.text());
      console.error(message.text());
    }
  });
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/moving-wall.html')}`, errors);
  const result = await page.evaluate(() => window.runMovingWall());
  assert.deepEqual(errors, []);
  console.log('Moving wall CCD:', JSON.stringify(result));
  assert.equal(result.initial, false);
  assert.equal(result.current[3], 0, 'a current-pose query cannot see the wall crossing');
  assert.equal(result.swept[3], 1, 'relative sweep must catch a wall crossing a stationary particle');
  assert(result.swept[4] > 1.06, 'contact must be carried to the current wall pose on the original side');
  assert(Math.abs(result.swept[12] - 2) < 1e-5);
  assert.deepEqual(result.swept, result.repeated, 'same-step prepare calls must retain the previous pose');
  assert.equal(result.stationary, false, 'motion must expire on the next stationary step');
  assert.equal(result.rotating[3], 1);
  assert(result.rotating[5] < -0.06, 'rotation must retain the original side of the wall');
  assert.equal(result.stats.fullBuilds, 1, 'rigid motion must not rebuild triangle data');
  assert.equal(result.stats.geometryRefits, 0);
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`, errors);
  const fluid = await page.evaluate(() => window.testMovingFluidWall());
  console.log('FLIP wall crossing:', JSON.stringify(fluid));
  assert.equal(fluid.moved.length, 2);
  assert(fluid.motion, 'dependent collision prepares must not erase the owning fluid step history');
  assert(fluid.moved.every(p => p.position[0] >= 1.06));
  assert(fluid.moved.every(p => p.velocity.every(Number.isFinite)));
  assert.equal(fluid.stats.transformUpdates - fluid.before.transformUpdates, 1);
  assert.equal(fluid.stats.fullBuilds, fluid.before.fullBuilds);
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await site.close(); }
