import { browserLaunchOptions } from '../../../../../scripts/browser/launch.utils.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { openFixture } from '../../../tests/fluids/openFixture.mjs';
import { startSiteDev } from '../../../../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-teapot-spout';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch(browserLaunchOptions('diagnostic', { protocolTimeout: 120000 }));
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  await openFixture(page, `${origin}/@fs${path.resolve(import.meta.dirname,
    '../../../tests/fluids/fixtures/fluid.html')}?demoLiquid`, errors);
  const result = await page.evaluate(async ({ bake, cellSize }) => {
    const { THREE, system, flip, scene, renderer } = window.debugFluid;
    const collider = flip.fluidColliders.find(value => value.geometry.attributes.position.count > 100);
    if (bake) {
      collider.bakedFieldResolution = bake;
      collider.prepareGPUField(renderer);
    }
    const bvh = collider.getCurrentBVH();
    const centerline = [];
    for (const x of [1.7, 1.9, 2.1, 2.3, 2.5, 2.6, 2.7]) {
      const hits = bvh.raycast(new THREE.Ray(new THREE.Vector3(x, 3, 0), new THREE.Vector3(0, -1, 0)),
        THREE.DoubleSide);
      const y = [...new Set(hits.map(hit => hit.point.y))].sort((a, b) => a - b);
      const local = new THREE.Vector3(x, (y[1] + y[2]) * 0.5, 0);
      const clearance = bvh.closestPointToPoint(local).distance * collider.getWorldScale(new THREE.Vector3()).x;
      const simulation = system.worldToLocal(collider.localToWorld(local.clone()));
      centerline.push({ local: local.toArray(), simulation: simulation.toArray(), clearance });
    }
    const sweeps = [];
    const wallStart = collider.localToWorld(new THREE.Vector3(0, 1, 0));
    const wallEnd = collider.localToWorld(new THREE.Vector3(0, -0.3, 0));
    const wallControl = await window.probe(wallStart.toArray(), wallEnd.toArray(), 0.0425);
    if (!wallControl[3]) throw new Error('Positive-control sweep missed the teapot bottom.');
    for (const radius of [0.0425, 0.025]) {
      const hits = [];
      for (let i = 1; i < centerline.length; i++) {
        const start = system.localToWorld(new THREE.Vector3(...centerline[i - 1].simulation)).toArray();
        const hit = await window.probe(start,
          system.localToWorld(new THREE.Vector3(...centerline[i].simulation)).toArray(), radius);
        hits.push({ found: hit[3] !== 0, normal: hit.slice(4, 7) });
      }
      sweeps.push({ radius, hits });
    }
    // Probe the actual geometry-local bake independently of sparse page residency.
    // Each row follows the mesh interior, rather than inferring logical order from packed slots.
    const { Fn, instanceIndex, storage, vec4, StorageBufferAttribute } = window.debugFluid.gpu;
    const points = new Float32Array(centerline.flatMap(value => [...value.simulation, 0]));
    const input = storage(new StorageBufferAttribute(points, 4), 'vec4', centerline.length);
    const attribute = new StorageBufferAttribute(new Float32Array(centerline.length * 4), 4);
    const samples = storage(attribute, 'vec4', centerline.length);
    const context = system.gpuSimulation.prepareContext(renderer);
    renderer.compute(Fn(() => {
      const position = input.element(instanceIndex).xyz;
      samples.element(instanceIndex).assign(vec4(collider.testPositionGPU(position, context), 0, 0, 0));
    })().compute(centerline.length));
    const baked = [...new Float32Array(await renderer.getArrayBufferAsync(attribute))];
    const grids = centerline.map((value, index) => ({ ...value, occupancy: baked[index * 4] }));
    const h = cellSize; // Representative settled tier; initial empty-domain width is not a discharge fixture.
    const box = new THREE.Box3(new THREE.Vector3(1.2, 0.4, -0.6), new THREE.Vector3(3.5, 2.5, 0.6));
    box.applyMatrix4(collider.matrixWorld).applyMatrix4(system.matrixWorld.clone().invert());
    const origin = box.min.toArray().map((value, axis) => Math.floor(
      (value - flip.bounds.min.getComponent(axis)) / h));
    const dimensions = box.max.toArray().map((value, axis) => Math.ceil(
      (value - flip.bounds.min.getComponent(axis)) / h) - origin[axis]);
    const count = dimensions.reduce((a, b) => a * b, 1);
    const coordinates = new Float32Array(count * 4), local = [];
    for (let i = 0; i < count; i++) {
      const c = [i % dimensions[0], Math.floor(i / dimensions[0]) % dimensions[1],
        Math.floor(i / (dimensions[0] * dimensions[1]))];
      const point = new THREE.Vector3(...c.map((value, axis) =>
        flip.bounds.min.getComponent(axis) + (origin[axis] + value + 0.5) * h));
      coordinates.set([...point.toArray(), 0], i * 4);
      local.push(collider.worldToLocal(system.localToWorld(point.clone())));
    }
    const lattice = storage(new StorageBufferAttribute(coordinates, 4), 'vec4', count);
    const field = new StorageBufferAttribute(new Float32Array(count * 4), 4);
    const output = storage(field, 'vec4', count);
    renderer.compute(Fn(() => {
      const position = lattice.element(instanceIndex).xyz;
      const faces = [];
      for (let axis = 0; axis < 3; axis++) {
        let open = collider.testPositionGPU(position, context).mul(0);
        for (let q = 0; q < 4; q++) {
          const delta = [0, 0, 0];
          delta[axis] = -0.5 * h;
          delta[(axis + 1) % 3] = ((q % 2) - 0.5) * 0.5 * h;
          delta[(axis + 2) % 3] = (Math.floor(q / 2) - 0.5) * 0.5 * h;
          const hit = collider.testPositionGPU(position.add(vec4(...delta, 0).xyz), context);
          open = open.add(hit.greaterThan(0).select(0, 0.25));
        }
        faces.push(open);
      }
      output.element(instanceIndex).assign(vec4(collider.testPositionGPU(position, context), ...faces));
    })().compute(count));
    const values = new Float32Array(await renderer.getArrayBufferAsync(field));
    const visited = new Int32Array(count).fill(-1), queue = [];
    // Reservoir-side interior seed; never seed exterior space above the vessel rim.
    local.forEach((point, i) => {
      if (point.x < 1.4 && point.y > 0.8 && point.y < 1.2 && Math.abs(point.z) < 0.1
        && values[4 * i] === 0) { visited[i] = i; queue.push(i); }
    });
    const interior = new Uint8Array(count), columns = new Map();
    for (let i = 0; i < count; i++) {
      const point = local[i];
      if (point.x < 1.65) { interior[i] = 1; continue; }
      const key = `${i % dimensions[0]}:${Math.floor(i / (dimensions[0] * dimensions[1]))}`;
      let interval = columns.get(key);
      if (!interval) {
        const hits = bvh.raycast(new THREE.Ray(new THREE.Vector3(point.x, 3, point.z),
          new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);
        const ys = hits.map(hit => hit.point.y).sort((a, b) => a - b)
          .filter((value, index, values) => index === 0 || value - values[index - 1] > 1e-5);
        // Past the open lip there is only the lower wall, not a closed roof.
        interval = ys.length >= 4 ? [ys[1], ys[2]]
          : point.x > 2.75 && ys.length === 2 ? [ys[1], 2.6] : [Infinity, -Infinity];
        columns.set(key, interval);
      }
      interior[i] = point.y > interval[0] && point.y < interval[1] ? 1 : 0;
    }
    let terminal = -1;
    const slices = [];
    const stride = [1, dimensions[0], dimensions[0] * dimensions[1]];
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], point = local[i];
      if (point.x > 3 && point.y > 2 && Math.abs(point.z) < 0.2) { terminal = i; break; }
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const c = Math.floor(i / stride[axis]) % dimensions[axis];
        if (c + sign < 0 || c + sign >= dimensions[axis]) continue;
        const j = i + sign * stride[axis], face = sign > 0 ? j : i;
        if (!interior[j] || visited[j] !== -1 || values[j * 4] > 0 || values[face * 4 + axis + 1] === 0) continue;
        visited[j] = i; queue.push(j);
      }
    }
    for (let x = 1.7; x <= 3.01; x += 0.1) {
      const ids = local.map((point, i) => Math.abs(point.x - x) < h / 0.76 * 0.5 ? i : -1)
        .filter(i => i >= 0 && interior[i]);
      slices.push({ x, interior: ids.length, open: ids.filter(i => values[i * 4] === 0).length,
        reached: ids.filter(i => visited[i] >= 0).length });
    }
    const route = [];
    if (terminal >= 0) for (let i = terminal; ; i = visited[i]) {
      route.push(local[i].toArray());
      if (visited[i] === i) break;
    }
    return { cellSize: h, bake: collider.bakedFieldResolution, centerline, wallControl, sweeps, grids,
      connectivity: { dimensions, cells: count, interiorCells: interior.reduce((a, b) => a + b, 0),
        visited: queue.length, connected: terminal >= 0, slices, route } };
  }, { bake: Number(process.env.BAKE) || undefined, cellSize: Number(process.env.CELL_SIZE) || 0.0625 });
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(result, null, 2));
  if (result.bake >= 96 && !result.connectivity.connected) {
    throw new Error('Configured teapot bake must retain an open-face path through the spout.');
  }
  console.log(JSON.stringify({ ...result, connectivity: { ...result.connectivity, route: undefined } }, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
