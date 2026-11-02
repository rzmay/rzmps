import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { capturePreview, parseOptions } from '../../scripts/preview/capture.mjs';

const deviceLoss = 'A valid external Instance reference no longer exists.';

for (const [backend, message, expectedAttempts] of [
  ['webgpu', deviceLoss, 3],
  ['webgpu', 'Instance dropped in popErrorScope', 3],
  ['webgpu', 'compute shader uses 9 storage buffers', 1],
  ['webgl', deviceLoss, 3],
  ['webgl', 'shader compilation failed', 1],
]) {
  test(`${backend}: ${message} fails after ${expectedAttempts} attempt(s)`, async t => {
    const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-preview-failure-'));
    const previousCI = process.env.CI;
    process.env.CI = 'true';
    let launches = 0;
    t.mock.method(puppeteer, 'launch', async options => {
      launches++;
      assert.ok(options.args.includes('--use-webgpu-adapter=swiftshader'));
      assert.ok(options.args.includes('--use-gpu-in-tests'));
      throw new Error(message);
    });
    try {
      const options = parseOptions(['--example', 'fireflies', '--backend', backend, '--output', output]);
      await assert.rejects(capturePreview(options), error => error.message.includes(message));
      assert.equal(launches, expectedAttempts);
      const metadata = JSON.parse(await fs.readFile(path.join(output, 'metadata.json'), 'utf8'));
      assert.equal(metadata.status, 'failed');
      assert.equal(metadata.attempts, expectedAttempts);
      assert.equal(metadata.warnings.length, expectedAttempts - 1);
    } finally {
      if (previousCI === undefined) delete process.env.CI;
      else process.env.CI = previousCI;
      t.mock.restoreAll();
      await fs.rm(output, { recursive: true, force: true });
    }
  });
}

for (const backend of ['webgl', 'webgpu']) test(`${backend}: device-loss recovery restarts the browser and captures`, {
  timeout: 240000,
}, async t => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-preview-recovery-'));
  const launch = puppeteer.launch.bind(puppeteer);
  const browsers = [];
  t.mock.method(puppeteer, 'launch', async options => {
    if (browsers.length) assert.equal(browsers[0].connected, false, 'failed browser must close before retry');
    const browser = await launch(options);
    browsers.push(browser);
    if (browsers.length === 1) {
      const newPage = browser.newPage.bind(browser);
      browser.newPage = async () => {
        const page = await newPage();
        page.evaluate = async () => { throw new Error(deviceLoss); };
        return page;
      };
    }
    return browser;
  });
  try {
    const result = await capturePreview(parseOptions([
      '--example', 'fire', '--backend', backend, '--warmup', '10', '--frames', '1',
      '--width', '320', '--height', '240', '--output', output,
    ]));
    assert.equal(result.status, 'complete');
    assert.equal(result.attempts, 2);
    assert.equal(browsers.length, 2);
    assert.ok(browsers.every(browser => !browser.connected));
    assert.ok(result.warnings.some(warning => warning.includes(deviceLoss)));
    assert.deepEqual(result.errors, []);
    assert.equal(result.captures[0].systems.find(system => system.name === 'Fire')?.gpuProcessingActive,
      backend === 'webgpu');
    assert.ok((await fs.stat(path.join(output, 'frame-000.png'))).size > 1000);
  } finally {
    t.mock.restoreAll();
    await Promise.all(browsers.map(browser => browser.close()));
    await fs.rm(output, { recursive: true, force: true });
  }
});
