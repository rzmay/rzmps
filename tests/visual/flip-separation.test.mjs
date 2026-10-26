import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('FLIP separation resolves coincident and mixed-size pairs without added velocity', { timeout: 120000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true,
      args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => window.runFrames(2));
    for (const [distance, sizes] of [[0, [0.1, 0.1]], [0.12, [0.1, 0.2]]]) {
      const pair = await page.evaluate(async ({ distance, sizes }) => {
        window.seedFLIPPair(distance, sizes);
        const stats = await window.runFrames(1);
        return { stats, positions: await window.readLivePositions() };
      }, { distance, sizes });
      assert.equal(pair.positions.length, 2);
      const [a, b] = pair.positions;
      const gap = Math.hypot(...a.map((v, axis) => v - b[axis]));
      assert.ok(gap > distance + 1e-4, 'both coincident and mixed-size neighbors must separate');
      assert.ok(pair.stats.speed < 1e-5, 'position regularization must not inject a velocity impulse');
      if (!distance) {
        assert.ok(Math.abs(a[0] + b[0]) < 1e-5);
        assert.ok(Math.abs(a[1] + b[1] - 6) < 1e-5);
        assert.ok(Math.abs(a[2] + b[2]) < 1e-5);
      }
    }
    await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?sourceWall`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => window.runFrames(2));
    const wall = await page.evaluate(async () => {
      window.seedFLIPPair(0, [0.1, 0.1], true);
      await window.runFrames(1);
      return window.readLivePositions();
    });
    assert.equal(wall.length, 2);
    for (const position of wall) {
      assert.ok(position[0] <= 0.45001, 'separation must keep the marker sphere outside the wall');
      assert.ok(Math.hypot(position[1] - 3, position[2]) > 1e-4,
        'a resting wall contact must preserve tangential separation');
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await site.close();
  }
});
