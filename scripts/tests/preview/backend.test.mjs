import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { browserArguments } from '../../preview/browser.mjs';

// Fast deployment gate: real Three.js WebGPU shaders + synchronized texture readback,
// without a demo build, documentation generation, or external assets.
test('headless WebGPU readback preserves colors and orientation at an unaligned width', {timeout:30000}, async () => {
  const server = createServer(async (req,res) => {
    try {
      if (req.url === '/') { res.end('<!doctype html><title>WebGPU probe</title>'); return; }
      const modules = {
        '/three.webgpu.js': '../../../node_modules/three/build/three.webgpu.js',
        '/three.core.js': '../../../node_modules/three/build/three.core.js',
        '/readTargetPNG.mjs': '../../preview/readTargetPNG.mjs',
      };
      if (!modules[req.url]) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type','text/javascript');
      res.end(await fs.readFile(new URL(modules[req.url],import.meta.url)));
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser = await puppeteer.launch({headless:true,args:browserArguments()});
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const T = await import('/three.webgpu.js');
      const {readTargetPNG} = await import('/readTargetPNG.mjs');
      const renderer = new T.WebGPURenderer({forceWebGL:false});
      await renderer.init();
      if (!renderer.backend.isWebGPUBackend) throw new Error('WebGPU fallback is forbidden');
      const target = new T.RenderTarget(66,48);
      target.texture.colorSpace = T.SRGBColorSpace;
      const scene = new T.Scene(); scene.background = new T.Color('blue');
      const mesh = new T.Mesh(new T.PlaneGeometry(2,1),new T.MeshBasicMaterial({color:'red'}));
      mesh.position.y=.5; scene.add(mesh);
      const camera = new T.OrthographicCamera(-1,1,1,-1,.1,10); camera.position.z=2;
      await renderer.compileAsync(scene,camera);
      renderer.setRenderTarget(target); renderer.render(scene,camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const png = await readTargetPNG(renderer,target,66,48);
      const image = new Image(); image.src=png; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=66;canvas.height=48;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const top=[...ctx.getImageData(33,12,1,1).data], bottom=[...ctx.getImageData(33,36,1,1).data];
      target.dispose();renderer.dispose();return {top,bottom,png:png.slice(0,22)};
    });
    assert.equal(result.png,'data:image/png;base64,');
    assert.ok(result.top[0]>240 && result.top[2]<10,JSON.stringify(result));
    assert.ok(result.bottom[2]>240 && result.bottom[0]<10,JSON.stringify(result));
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
});
