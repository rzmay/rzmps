import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`);
  await page.waitForFunction(() => window.ready);
  const result = await page.evaluate(async () => {
    const { flip, renderer, gpu: { Fn, instanceIndex, vec4 } } = window.debugFluid;
    // This synthetic column is independent of the emitter: activate every brick
    // so the compact path must also agree across all shared brick faces.
    const grid = flip.workGrid;
    renderer.compute(Fn(() => {
      grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
      grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
    })().compute(grid.brickCount));
    grid.updateDispatch(renderer);
    renderer.compute(flip.computeCells(index => {
      const c = flip.cellCoordinate(index);
      const solid = c.x.lessThan(20).or(c.x.greaterThan(28))
        .or(c.z.lessThan(20)).or(c.z.greaterThan(28)).or(c.y.lessThan(20));
      const fluid = solid.not().and(c.y.lessThanEqual(28));
      flip.solid.element(index).assign(solid.select(1, 0));
      flip.velocityNext.element(index).assign(vec4(0, -0.1, 0, fluid.select(2, 0)));
      flip.velocityBefore.element(index).assign(vec4(0, 0, 0, fluid.select(1, 0)));
    }));
    // Converge this wall-bounded column before checking its hydrostatic limit.
    flip.pressureIterations = 512;
    flip.solveProjection(renderer, flip.velocityNext, flip.velocityCurrent);
    const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
    const faces = await read(flip.pressureProjection.attribute);
    const pressure = await read(flip.pressureCurrentAttribute);
    const rhs = await read(flip.divergenceAttribute);
    const solid = await read(flip.solidAttribute);
    const n = flip.resolution, side = n + 1, h = flip.cellSize;
    const index = (x, y, z) => x + n * (y + n * z);
    const face = (x, y, z, axis) => faces[4 * (x + side * (y + side * z)) + axis];
    let before = 0, after = 0, residualError = 0, blockedFlux = 0, count = 0;
    for (let z = 20; z <= 28; z++) for (let y = 20; y <= 28; y++) for (let x = 20; x <= 28; x++) {
      const at = index(x, y, z);
      const divergence = (face(x + 1, y, z, 0) - face(x, y, z, 0)
        + face(x, y + 1, z, 1) - face(x, y, z, 1)
        + face(x, y, z + 1, 2) - face(x, y, z, 2)) / h;
      let laplacian = 0;
      for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
        const c = [x, y, z];
        c[axis] += sign;
        const neighbor = index(...c);
        if (!solid[neighbor]) laplacian += pressure[neighbor] - pressure[at];
        else {
          const f = [x, y, z];
          if (sign > 0) f[axis]++;
          blockedFlux = Math.max(blockedFlux, Math.abs(face(...f, axis)));
        }
      }
      residualError = Math.max(residualError, Math.abs(divergence - (rhs[at] - laplacian / (h * h))));
      before += rhs[at] ** 2;
      after += divergence ** 2;
      count++;
    }
    return { before: Math.sqrt(before / count), after: Math.sqrt(after / count), residualError, blockedFlux };
  });
  console.log('Liquid hydrostatic projection:', JSON.stringify(result));
  assert(result.after < result.before * 0.1, 'gravity in a closed-sided liquid column must be pressure-supported');
  assert(result.residualError < 1e-4, 'liquid divergence, Laplacian and gradient must use the same operator');
  assert.equal(result.blockedFlux, 0, 'pressure must not introduce flux through the vessel walls');
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await site.close();
}
