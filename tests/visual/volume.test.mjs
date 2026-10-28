import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

test('volume providers combine density/color with tags on WebGL and WebGPU', { timeout: 120000 }, async () => {
  const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'rzmps-volume-'));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true,
      args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
    const fixture = path.resolve(import.meta.dirname, 'fixtures/volume.html');
    for (const backend of ['webgl', 'webgpu']) {
      await page.setViewport({ width: 480, height: 320 });
      await page.goto(`${origin}/@fs${fixture}?backend=${backend}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.ready, { timeout: 60000 }).catch(error => {
        throw new Error(`${error.message}\n${errors.join('\n')}`);
      });
      const both = await page.evaluate(() => window.renderVolume());
      console.log(backend, JSON.stringify(both));
      assert.equal(both.layers, 2);
      assert.equal(both.children, 0);
      assert.ok(both.left[0] > 50 && both.left[2] < 5, 'left-only density is red');
      assert.ok(both.right[2] > 50 && both.right[0] < 5, 'right-only density is blue');
      assert.ok(both.middle[0] > 10 && both.middle[2] > both.middle[0], 'overlap mixes by density');
      assert.ok(Math.max(...both.outside.slice(0, 3)) < 5, 'fields do not clamp outside their bounds');
      assert.deepEqual(both.bounds, [[-1.5, -1, -0.5], [1.5, 1, 0.5]]);
      await page.screenshot({ path: path.join(output, `${backend}.png`) });
      const red = await page.evaluate(() => window.renderVolume(['red']));
      assert.equal(red.layers, 1);
      assert.ok(red.middle[0] > 50 && red.middle[2] < 5);
      assert.ok(Math.max(...red.right.slice(0, 3)) < 5);
      const universal = await page.evaluate(async () => {
        window.volumeFixture.blue.tags = null;
        return window.renderVolume(['red']);
      });
      assert.equal(universal.layers, 2);
      const additive = await page.evaluate(async () => {
        const { red, blue, volume } = window.volumeFixture;
        for (const source of [red, blue]) {
          source.density.data.fill(0.03);
          source.density.version++;
        }
        volume.threshold = 0.05;
        volume.range = 0.01;
        return window.renderVolume(['red']);
      });
      assert.ok(additive.middle[0] > 10 && additive.middle[2] > 10,
        'two individually sub-threshold densities must add before opacity is evaluated');
      assert.ok(Math.max(...additive.left.slice(0, 3)) < 5);
      assert.ok(Math.max(...additive.right.slice(0, 3)) < 5);
      const removed = await page.evaluate(async () => {
        const { system, blue } = window.volumeFixture;
        system.removeModule(blue);
        return window.renderVolume(['red']);
      });
      assert.equal(removed.layers, 1);
      assert.ok(removed.middle[2] < 5);
      const controls = await page.evaluate(async () => {
        const { red, volume } = window.volumeFixture;
        volume.generateChildren = false;
        const noChildren = await window.renderVolume(['red']);
        volume.generateChildren = true;
        volume.children = { count: 1, radius: 0, scale: 1, alpha: 1 };
        const child = await window.renderVolume(['red']);
        volume.children = { count: 2, radius: 0, scale: 1, alpha: 0.5 };
        const halfChildren = await window.renderVolume(['red']);
        const sourceUnchanged = red.density.data.every(value => Math.abs(value - 0.03) < 1e-6);
        volume.children = { count: 2, radius: 0.3, scale: 1.2, alpha: 0.5 };
        const expanded = await window.renderVolume(['red']);
        volume.generateChildren = false;
        volume.densityMapping = 'Linear';
        volume.densityRange = [0, 1];
        volume.opacity = 0.03;
        volume.steps = 512;
        red.density.data.fill(0.4);
        red.density.version++;
        volume.stepSizeMultiplier = 2;
        const coarse = await window.renderVolume(['red']);
        volume.stepSizeMultiplier = 0.25;
        const fine = await window.renderVolume(['red']);
        volume.generateChildren = true;
        volume.children = { count: 1, radius: 0, scale: 0.1, alpha: 0.001 };
        const tinyChild = await window.renderVolume(['red']);
        volume.generateChildren = false;
        volume.densityGain = 2;
        const gain = await window.renderVolume(['red']);
        volume.densityGain = 1;
        volume.densityMapping = 'Curve';
        volume.densityCurve = t => t * t;
        const curve = await window.renderVolume(['red']);
        volume.densityMapping = 'None';
        const hidden = await window.renderVolume(['red']);
        volume.densityMapping = 'Curve';
        volume.densityCurve = 1;
        red.density.data.fill(0);
        red.density.version++;
        const empty = await window.renderVolume(['red']);
        volume.densityMapping = 'Linear';
        for (let i = 0; i < red.density.data.length; i++) red.density.data[i] = i % 8 % 2;
        red.density.version++;
        const filters = {};
        for (const mode of ['Nearest', 'Linear', 'Cubic']) {
          volume.interpolation = mode;
          filters[mode] = await window.renderVolume(['red']);
        }
        return { noChildren, child, halfChildren, sourceUnchanged, expanded, coarse, fine, tinyChild, gain, curve,
          hidden, empty, filters };
      });
      console.log(backend, 'controls', JSON.stringify(controls));
      assert.ok(controls.noChildren.middle[0] < 5);
      assert.ok(controls.child.middle[0] > 10, 'coincident copies add density before opacity mapping');
      assert.ok(Math.abs(controls.child.middle[0] - controls.halfChildren.middle[0]) <= 2);
      assert.equal(controls.sourceUnchanged, true, 'render children must not change simulation density');
      assert.equal(controls.expanded.children, 2);
      assert.ok(controls.expanded.bounds[1][0] - controls.expanded.bounds[0][0] >= 2.4);
      assert.ok(Math.abs(controls.coarse.middle[0] - controls.fine.middle[0]) <= 2,
        'ray step quality must not act as density gain');
      assert.ok(controls.gain.middle[0] > controls.fine.middle[0]);
      assert.ok(Math.abs(controls.tinyChild.middle[0] - controls.fine.middle[0]) <= 2,
        'a small child footprint must not rescale parent optical density');
      assert.ok(controls.curve.middle[0] < controls.fine.middle[0]);
      assert.equal(controls.hidden.middle[0], 0);
      assert.equal(controls.empty.middle[0], 0);
      assert.ok(controls.filters.Nearest.middle[0] < controls.filters.Linear.middle[0]);
      assert.ok(controls.filters.Cubic.middle[0] > 5);
      await page.setViewport({ width: 390, height: 844 });
      const mobilePixels = await page.evaluate(async () => {
        const { renderer, scene, camera, system, volume, red, blue } = window.volumeFixture;
        red.density.data.fill(0.5);
        blue.density.data.fill(1.5);
        red.density.version++;
        blue.density.version++;
        system.addModule(blue);
        volume.threshold = 0.1;
        volume.range = 0.05;
        volume.opacity = 0.08;
        volume.interpolation = 'Linear';
        volume.densityMapping = 'Smoothstep';
        volume.densityGain = 1;
        volume.stepSizeMultiplier = 1;
        volume.tags = undefined;
        volume.update([], system, 0);
        renderer.setSize(390, 844);
        camera.aspect = 390 / 844;
        camera.position.z = 14;
        camera.updateProjectionMatrix();
        if (renderer.isWebGPURenderer) await renderer.renderAsync(scene, camera);
        else renderer.render(scene, camera);
        const canvas = document.createElement('canvas');
        canvas.width = 390;
        canvas.height = 844;
        const context = canvas.getContext('2d');
        context.drawImage(renderer.domElement, 0, 0);
        const pixels = context.getImageData(0, 0, 390, 844).data;
        let colored = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 10 || pixels[i + 2] > 10) colored++;
        }
        return colored;
      });
      assert.ok(mobilePixels > 100, 'mobile volume must remain visible');
      await page.screenshot({ path: path.join(output, `${backend}-mobile.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('Volume screenshots:', output);
  } finally {
    await browser?.close();
    await site.close();
  }
});
