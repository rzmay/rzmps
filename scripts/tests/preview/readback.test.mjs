import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer';
import { previewBrowserArguments } from '../../preview/browserSettings.mjs';
import { attachBrowserDiagnostics } from '../../preview/browserDiagnostics.mjs';

test('headless WebGPU renders and reads correct pixels without a canvas swap chain', { timeout: 45000 }, async () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  const output = path.join(root, 'benchmark-results/preview-diagnostics/preflight');
  await fs.mkdir(output, { recursive: true });
  const modules = {
    '/three.webgpu.js': path.join(root, 'node_modules/three/build/three.webgpu.js'),
    '/three.core.js': path.join(root, 'node_modules/three/build/three.core.js'),
    '/readback.mjs': path.join(root, 'scripts/preview/readback.utils.mjs'),
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        res.end('<!doctype html><title>WebGPU preflight</title>');
        return;
      }
      if (!modules[req.url]) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await fs.readFile(modules[req.url]));
    } catch (error) {
      res.writeHead(500).end(error.message);
    }
  });
  let browser, diagnostics;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const args = previewBrowserArguments();
    browser = await puppeteer.launch({ headless: true, args });
    const page = await browser.newPage();
    diagnostics = await attachBrowserDiagnostics(
      browser,
      page,
      { example: 'preflight', backend: 'webgpu', output },
      args,
    );
    await diagnostics.snapshot();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const T = await import('/three.webgpu.js');
      const { readTargetPNG } = await import('/readback.mjs');
      // Warm the real Three.js formatter that stalled under Chrome 154's Linux/x64 Maglev tier.
      const constants = [
        [0, '0.0'],
        [0.35, '0.35'],
        ['0.9', '0.9'],
        [-0.5, '-0.5'],
        [1e-7, '1e-7'],
      ];
      for (let iteration = 0; iteration < 10000; iteration++) {
        for (const [value, expected] of constants) {
          const actual = T.NodeBuilder.prototype.generateConst.call(null, 'float', value);
          if (actual !== expected) throw new Error(`Incorrect shader constant: ${actual}`);
        }
      }

      const renderer = new T.WebGPURenderer({ forceWebGL: false });
      await renderer.init();
      if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPU preflight used a fallback');
      const target = new T.RenderTarget(66, 48);
      target.texture.colorSpace = T.SRGBColorSpace;
      const scene = new T.Scene();
      scene.background = new T.Color('blue');
      const material = new T.MeshBasicMaterial({ color: 'red' });
      const geometry = new T.PlaneGeometry(2, 1);
      const mesh = new T.Mesh(geometry, material);
      mesh.position.y = 0.5;
      scene.add(mesh);
      const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
      camera.position.z = 2;
      renderer.setRenderTarget(target);
      await renderer.compileAsync(scene, camera);
      renderer.render(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const png = await readTargetPNG(renderer, target, 66, 48);
      const image = new Image();
      image.src = png;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 66;
      canvas.height = 48;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const top = [...context.getImageData(33, 12, 1, 1).data],
        bottom = [...context.getImageData(33, 36, 1, 1).data];
      geometry.dispose();
      material.dispose();
      target.dispose();
      renderer.dispose();
      return { png, top, bottom };
    });
    assert.ok(result.top[0] > 240 && result.top[2] < 10, JSON.stringify(result.top));
    assert.ok(result.bottom[2] > 240 && result.bottom[0] < 10, JSON.stringify(result.bottom));
    await fs.writeFile(path.join(output, 'pixels.png'), Buffer.from(result.png.split(',')[1], 'base64'));
  } finally {
    await diagnostics?.save();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
