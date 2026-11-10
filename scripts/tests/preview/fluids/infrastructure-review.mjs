import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';
import { openFixture } from './openFixture.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-fluid-infrastructure';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => {
    if (message.type() === 'error') { errors.push(message.text()); console.error(message.text()); }
  });
  const fixture = `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`;
  await openFixture(page, `${fixture}?example=gasVolume&measureStartup`, errors);
  const gas = await page.evaluate(async () => {
    const { system, renderer, flip, THREE, scene } = window.debugFluid;
    const warm = [];
    for (let frame = 0; frame < 8; frame++) {
      const start = performance.now();
      system.advanceFrames(1, 1 / 60);
      const cpuMs = performance.now() - start;
      await renderer.backend.device.queue.onSubmittedWorkDone();
      warm.push({ cpuMs, fencedMs: performance.now() - start });
    }
    const obstacle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
    obstacle.position.set(0, 0.25, 0);
    scene.add(obstacle);
    flip.collisionOptions = { world: scene, objectFilter: mesh => mesh === obstacle };
    system.advanceFrames(1, 1 / 60);
    const collected = flip.collectedColliders.size;
    const coordinate = system.worldToSimulation(obstacle.getWorldPosition(new THREE.Vector3()))
      .sub(flip.bounds.min).divideScalar(flip.cellSize).floor();
    const grid = flip.volumeGrid;
    const brick = coordinate.clone().divideScalar(grid.brickSide).floor();
    const side = 2 ** grid.brickSubdivisions;
    const pages = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
    const page = pages[brick.x + side * (brick.y + side * brick.z)];
    const local = coordinate.sub(brick.multiplyScalar(grid.brickSide));
    const address = (page - 1) * grid.cellsPerBrick + local.x
      + grid.brickSide * (local.y + grid.brickSide * local.z);
    const solidCell = new Float32Array(await renderer.getArrayBufferAsync(
      flip.solidAttribute, null, address * 4, 4))[0];
    const state = await window.runFrames(0);
    return { startup: window.fluidStartup, warm, collected, solidCell, resolution: flip.resolution,
      capacity: flip.volumeGrid.capacity, activeBricks: (await flip.readGridDiagnostics(renderer)).activeBricks,
      sourceParticles: state.count, field: state.field };
  });
  assert(gas.startup.textureRetained, 'startup must retain the constructor field bindings');
  assert.equal(gas.collected, 1);
  assert.equal(gas.solidCell, 1, 'collected mesh interiors must block gas cells');
  assert(gas.field.sum > 0 && gas.field.nonfinite === 0);
  for (const [name, position] of [['oblique', [5, 4, 6]], ['close', [0.2, 0.6, 1.2]]]) {
    await page.evaluate(async position => {
      const { renderer, scene, camera } = window.debugFluid;
      camera.position.set(...position); camera.lookAt(0, 0.6, 0);
      await renderer.renderAsync(scene, camera);
    }, position);
    await page.screenshot({ path: path.join(output, `gas-${name}.png`) });
  }
  console.log('Gas startup and mesh collection:', JSON.stringify(gas));

  await openFixture(page, `${fixture}?example=flipFluid&demoLiquid=true`, errors);
  const liquid = await page.evaluate(async () => {
    const { system, renderer } = window.debugFluid;
    const spray = [...system.subSystems.keys()][0];
    let peakSpray = 0;
    for (let batch = 0; batch < 4; batch++) {
      for (let frame = 0; frame < 30; frame++) system.advanceFrames(1, 1 / 60);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const particles = await spray.selectiveReadback(4096, ['position', 'scale', 'color', 'alpha']);
      peakSpray = Math.max(peakSpray, particles.filter(({ particle }) => particle.alive).length);
    }
    const stats = await window.runFrames(0);
    return { liquidParticles: stats.count, peakSpray, policy: system.modules[0].boundsPolicy,
      grids: system.spatialRuntime._particleSpatialGrids.size };
  });
  assert(liquid.peakSpray > 0, 'the liquid preset must produce visible spray particles');
  await page.screenshot({ path: path.join(output, 'liquid-and-spray.png') });
  await page.evaluate(async () => {
    const { system, renderer, scene, camera } = window.debugFluid;
    system.renderers[0].mesh.visible = false;
    await renderer.renderAsync(scene, camera);
  });
  await page.screenshot({ path: path.join(output, 'spray-only.png') });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify({ gas, liquid }, null, 2));
  console.log('Liquid spray:', JSON.stringify(liquid));
  console.log(`Infrastructure review: ${output}`);
} finally {
  await browser?.close();
  await site.close();
}
