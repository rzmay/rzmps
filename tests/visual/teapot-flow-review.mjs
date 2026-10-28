import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const outcomes = [];
  for (const angle of [35, 60]) {
    await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
      path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?demoLiquid`);
    await page.waitForFunction(() => window.ready);
    outcomes.push(await page.evaluate(async angle => {
      const { system, flip, renderer, scene, sceneLifecycle, THREE } = window.debugFluid;
      const controls = {};
      sceneLifecycle.gui({ add(target, key) {
        const control = { name() { return this; }, listen() { return this; },
          onChange(fn) { this.change = fn; return this; },
          set(value) { target[key] = value; this.change?.(value); } };
        controls[key] = control;
        return control;
      } });
      await window.runFrames(900);
      const velocity = new Float32Array(await renderer.getArrayBufferAsync(flip.velocityCurrentAttribute));
      const solid = new Float32Array(await renderer.getArrayBufferAsync(flip.solidAttribute));
      let supported = 0, artificialAir = 0;
      const offset = flip.cellCount * 4;
      for (let i = 0; i < flip.cellCount; i++) {
        if (velocity[offset + i * 4 + 3] > 0.75 && solid[i] < 0.5) {
          supported++;
          if (velocity[i * 4 + 3] < 1.5) artificialAir++;
        }
      }
      system.stop(false);
      controls.tip.set(angle);
      let spout = 0, outlet = 0;
      const collider = scene.getObjectByName('Utah Teapot Fluid Collider');
      for (let frame = 0; frame < 480; frame++) {
        sceneLifecycle.update(1 / 60);
        system.advanceFrames(1, 1 / 60);
        if (frame % 30 === 0) {
          await renderer.backend.device.queue.onSubmittedWorkDone();
          const samples = (await system.selectiveReadback(32000, ['position']))
            .filter(({ particle }) => particle.alive);
          const local = samples.map(({ particle }) => collider.worldToLocal(system.localToWorld(particle.position)));
          spout = Math.max(spout, local.filter(p => p.x > 2.5 && p.x < 3 && Math.abs(p.z) < 0.4).length);
          outlet = Math.max(outlet, local.filter(p => p.x > 3 && p.y > 2 && Math.abs(p.z) < 0.4).length);
        }
      }
      const mesh = system.renderers[0];
      const diagnostics = await mesh.readSurfaceDiagnostics();
      const draw = new Uint32Array(await renderer.getArrayBufferAsync(mesh.surface.drawAttribute));
      const indices = new Uint32Array(await renderer.getArrayBufferAsync(mesh.surface.indexAttribute));
      const edges = new Map();
      for (let i = 0; i < draw[0]; i += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const first = indices[i + a], second = indices[i + b];
        const edge = `${Math.min(first, second)},${Math.max(first, second)}`;
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
      const samples = (await system.selectiveReadback(32000, ['position']))
        .filter(({ particle }) => particle.alive);
      const world = samples.map(({ particle }) => system.localToWorld(particle.position));
      const bodyHeights = world.filter(p => {
        const local = collider.worldToLocal(p.clone());
        return local.x < 1.3 && Math.abs(local.z) < 1.3 && local.y < 2;
      }).map(p => p.y).sort((a, b) => a - b);
      const top = bodyHeights[Math.floor(bodyHeights.length * 0.95)];
      const lip = collider.localToWorld(new THREE.Vector3(3, 2.4, 0)).y;
      return { angle, supported, artificialAir, spout, outlet, top, lip, head: top - lip,
        openEdges: [...edges.values()].filter(count => count === 1).length,
        nonmanifoldEdges: [...edges.values()].filter(count => count > 2).length, surface: diagnostics };
    }, angle));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ outcomes }, null, 2));
} finally { await browser?.close(); await site.close(); }
