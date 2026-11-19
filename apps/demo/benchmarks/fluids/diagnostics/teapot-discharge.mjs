import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
await site.demo.watcher.close();
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 120000 }));
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixture = path.resolve('apps/demo/tests/fluids/fixtures/fluid.html');
  await openFixture(page, `http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${fixture}?demoLiquid`, errors);
  const result = await page.evaluate(async () => {
    const { system, renderer, scene, flip, sceneLifecycle, THREE, gpu } = window.debugFluid;
    for (let frame = 0; frame < 750; frame++) {
      sceneLifecycle.update(1 / 60);
      system.advanceFrames(1, 1 / 60);
      await renderer.backend.device.queue.onSubmittedWorkDone();
    }
    const model = scene.getObjectByName('Lidless Utah Teapot');
    const toModel = model.matrixWorld.clone().invert().multiply(system.getSimulationToWorldMatrix());
    const surface = system.renderers[0], mesh = surface.surface, diagnostics = await surface.readSurfaceDiagnostics();
    const [vertexBuffer, indexBuffer] = await Promise.all([
      renderer.getArrayBufferAsync(mesh.positionAttribute), renderer.getArrayBufferAsync(mesh.indexAttribute),
    ]);
    const vertices = new Float32Array(vertexBuffer), indices = new Uint32Array(indexBuffer);
    const outlet = p => p.x > 3 && p.y > 2 && Math.abs(p.z) < 0.4;
    const spout = p => p.x > 2.5 && p.x < 3 && Math.abs(p.z) < 0.4;
    let surfaceOutletTriangles = 0, surfaceSpoutTriangles = 0;
    for (let i = 0; i < diagnostics.triangles * 3; i += 3) {
      const center = new THREE.Vector3();
      for (let k = 0; k < 3; k++) center.add(new THREE.Vector3().fromArray(vertices, indices[i + k] * 4));
      center.multiplyScalar(1 / 3).applyMatrix4(toModel);
      surfaceOutletTriangles += Number(outlet(center)); surfaceSpoutTriangles += Number(spout(center));
    }
    const markers = (await system.selectiveReadback(32000, ['position']))
      .filter(({ particle }) => particle.alive).map(({ particle }) => particle.position.clone().applyMatrix4(toModel));

    // Integrate relative flux through an interior spout section in the vessel's current frame.
    const side = 24, count = side ** 2, points = new Float32Array(count * 4);
    const toSimulation = toModel.clone().invert();
    for (let i = 0; i < count; i++) {
      const point = new THREE.Vector3(2.6, 1.45 + ((i % side) + 0.5) / side * 0.6,
        -0.3 + (Math.floor(i / side) + 0.5) / side * 0.6).applyMatrix4(toSimulation);
      points.set([...point.toArray(), 0], i * 4);
    }
    const { Fn, instanceIndex, storage, vec4, StorageBufferAttribute } = gpu;
    const inputAttribute = new StorageBufferAttribute(points, 4);
    const attribute = new StorageBufferAttribute(new Float32Array(count * 4), 4);
    const input = storage(inputAttribute, 'vec4', count), output = storage(attribute, 'vec4', count);
    const collider = flip.fluidColliders.find(value => value.geometry.attributes.position.count > 100);
    const previous = flip.boundaryMotion.get(collider).transform;
    const normal = new THREE.Vector3(1, 0, 0).transformDirection(toSimulation);
    const normalNode = vec4(normal.x, normal.y, normal.z, 0).xyz;
    const projection = flip.getPressureProjection();
    const node = Fn(() => {
      const p = input.element(instanceIndex).xyz;
      const velocity = projection.sample(p.sub(flip.boundsMinNode).div(flip.cellSizeNode));
      const wall = p.sub(previous.mul(vec4(p, 1)).xyz).div(flip.boundaryDt);
      output.element(instanceIndex).assign(vec4(velocity.sub(wall).dot(normalNode), 0, 0, 0));
    })().compute(count);
    renderer.compute(node);
    const values = new Float32Array(await renderer.getArrayBufferAsync(attribute));
    const scale = model.getWorldScale(new THREE.Vector3()).x;
    let relativeGridFlux = 0;
    for (let i = 0; i < count; i++) relativeGridFlux += values[i * 4] * (0.6 * scale / side) ** 2;
    node.dispose();
    for (const value of [attribute, inputAttribute]) { renderer.backend.destroyAttribute(value); value.dispose(); }
    return { seconds: 12.5, cellWidth: flip.cellSize, relativeGridFlux,
      spoutMarkers: markers.filter(spout).length, outletMarkers: markers.filter(outlet).length,
      surfaceSpoutTriangles, surfaceOutletTriangles, diagnostics };
  });
  await fs.writeFile(process.argv[2] ?? '/tmp/liquid-teapot-discharge.json',
    JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify(result));
  assert.deepEqual(errors, []);
  assert(result.relativeGridFlux > 0, 'the grid must carry liquid outward through the spout');
  assert(result.outletMarkers > 0, 'markers must pass through the outlet');
  assert(result.surfaceOutletTriangles > 0, 'the drawn surface must cover discharged liquid');
  assert.equal(result.diagnostics.overflowedBricks, 0);
  assert.equal(result.diagnostics.overflowedTriangles, 0);
} finally { await browser?.close(); await site.close(); }
