import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const output = process.argv[2] ?? '/tmp/rzmps-teapot-spout';
await fs.mkdir(output, { recursive: true });
const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true,
    args: ['--enable-unsafe-webgpu', ...(process.env.CI === 'true' ? ['--no-sandbox'] : [])] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${site.demo.httpServer.address().port}`;
  await page.goto(`${origin}/@fs${path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`,
    { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.ready);
  const result = await page.evaluate(async () => {
    const { THREE, system, flip, scene, renderer } = window.debugFluid;
    const collider = scene.getObjectByName('Utah Teapot Fluid Collider');
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
    const wallStart = system.worldToLocal(collider.localToWorld(new THREE.Vector3(0, 1, 0)));
    const wallEnd = system.worldToLocal(collider.localToWorld(new THREE.Vector3(0, -0.3, 0)));
    const wallControl = await window.probe(wallStart.toArray(), wallEnd.toArray(), 0.0425);
    if (!wallControl[3]) throw new Error('Positive-control sweep missed the teapot bottom.');
    for (const radius of [0.0425, 0.025]) {
      const hits = [];
      for (let i = 1; i < centerline.length; i++) {
        const hit = await window.probe(centerline[i - 1].simulation, centerline[i].simulation, radius);
        hits.push({ found: hit[3] !== 0, normal: hit.slice(4, 7) });
      }
      sweeps.push({ radius, hits });
    }
    flip.automaticPadding = false;
    flip.pressureIterations = 0;
    system.emitters.length = 0;
    const grids = [];
    for (const [subdivisions, bake, side] of [[4, 48, 16], [5, 48, 16], [5, 96, 16],
      [4, 96, 8], [5, 96, 8]]) {
      collider.bakedFieldResolution = bake;
      collider.needsUpdate = true;
      flip.setSpatialGridOptions({ brickSubdivisions: 2, cellSubdivisions: subdivisions });
      const half = side * 0.5;
      flip.pendingBounds = { grid: flip.getParticleSpatialGrid(system),
        bounds: new THREE.Box3(new THREE.Vector3(-half, -half, -half), new THREE.Vector3(half, half, half)) };
      await window.runFrames(1);
      const solid = new Float32Array(await renderer.getArrayBufferAsync(flip.solidAttribute));
      const samples = centerline.map(({ simulation }) => {
        const coordinate = simulation.map((value, axis) => Math.floor(
          (value - flip.bounds.min.getComponent(axis)) / flip.cellSize,
        ));
        const index = coordinate[0] + flip.resolution * (coordinate[1] + flip.resolution * coordinate[2]);
        return { coordinate, solid: solid[index] };
      });
      grids.push({ side, resolution: flip.resolution, cellSize: flip.cellSize, bake, samples });
    }
    return { centerline, wallControl, sweeps, grids };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(path.join(output, 'metrics.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await site.close();
}
