import assert from 'node:assert/strict';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../scripts/site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
    path.resolve(import.meta.dirname, 'fixtures/fluid.html')}?example=gasVolume&fixedGas=true&reviewGrid=2,4`);
  await page.waitForFunction(() => window.ready).catch(error => {
    throw new Error(`${error.message}\n${errors.join('\n')}`);
  });
  const frames = Number(process.env.SPARSE_FRAMES ?? 120);
  const result = await page.evaluate(async frames => {
    window.debugFluid.flip.maxActiveBricks = 32;
    const stats = await window.runFrames(frames);
    const { flip, renderer } = window.debugFluid;
    const grid = flip.volumeGrid;
    const read = async attribute => [...new Uint32Array(await renderer.getArrayBufferAsync(attribute))];
    return { stats, pages: (await read(grid.pagesAttribute)).slice(0, grid.brickCount),
      diagnostics: await read(grid.diagnosticsAttribute), cellCount: flip.cellCount };
  }, frames);
  console.log(JSON.stringify(result));
  assert(result.stats.field.sum > 0);
  assert.equal(result.diagnostics[1], 0, 'sparse pool must not overflow in the preset');
  assert(result.cellCount < 64 ** 3, 'field storage should be sparse');
  const projection = await page.evaluate(async () => {
    await window.projectGas(16, 'waves', false);
    return window.lastProjectionMetrics.faces;
  });
  assert(projection.after < projection.before, 'sparse pressure should reduce divergence');
  assert(projection.residualError < 1e-4, 'sparse brick interfaces must preserve the pressure operator');
  const persistent = await page.evaluate(async () => {
    window.stopGasSources();
    const stats = await window.runFrames(60);
    return { stats, allocation: await window.debugFluid.flip.readGridDiagnostics(window.debugFluid.renderer) };
  });
  assert.equal(persistent.stats.count, 0);
  assert(persistent.stats.field.sum > 0, 'emitted gas must survive source death');
  assert(persistent.allocation.activeBricks > 0);
  const released = await page.evaluate(async () => {
    window.debugFluid.flip.densityDissipation = 10;
    const stats = await window.runFrames(180);
    return { stats, allocation: await window.debugFluid.flip.readGridDiagnostics(window.debugFluid.renderer) };
  });
  assert.equal(released.stats.field.sum, 0);
  assert.equal(released.allocation.activeBricks, 0, 'empty bricks must be reclaimed');
  const recycled = await page.evaluate(async () => {
    window.seedGasSource();
    return window.runFrames(2);
  });
  assert(recycled.field.sum > 0, 'reclaimed slots must be reusable');
  assert.equal(recycled.field.nonfinite, 0);
  const scheduled = await page.evaluate(async () => {
    const { flip, renderer } = window.debugFluid;
    const grid = flip.volumeGrid;
    const { Fn, instanceIndex, storage, vec4, StorageBufferAttribute } = window.debugFluid.gpu;
    // Noncontiguous slots catch accidental dense-prefix addressing after compaction.
    renderer.compute(Fn(() => {
      grid.slots.element(instanceIndex).assign(
        instanceIndex.equal(1).or(instanceIndex.equal(grid.capacity - 1)).select(1, 0),
      );
      grid.fresh.element(instanceIndex).assign(instanceIndex.equal(grid.capacity - 1).select(1, 0));
    })().compute(grid.capacity));
    grid.updateDispatch(renderer);
    const outcomes = [];
    for (const fresh of [false, true]) for (const faces of [false, true]) {
      const size = faces ? (grid.brickSide + 1) ** 3 : grid.cellsPerBrick;
      const attribute = new StorageBufferAttribute(new Float32Array((grid.capacity * size + 1) * 4), 4);
      const values = storage(attribute, 'vec4', attribute.count);
      renderer.compute(grid.compute(index => { values.element(index).assign(vec4(index.add(1))); }, faces, fresh));
      const result = new Float32Array(await renderer.getArrayBufferAsync(attribute));
      let incorrect = 0;
      for (let index = 0; index < attribute.count; index++) {
        const slot = Math.floor(index / size);
        const selected = slot === grid.capacity - 1 || (!fresh && slot === 1);
        if (result[index * 4] !== (selected ? index + 1 : 0)) incorrect++;
      }
      const args = new Uint32Array(await renderer.getArrayBufferAsync(
        grid.dispatchAttributes[(fresh ? 2 : 0) + (faces ? 1 : 0)],
      ));
      outcomes.push({ incorrect, args: [...args], expected: [Math.ceil(size / 64), fresh ? 1 : 2, 1] });
      attribute.dispose();
    }
    return { outcomes, clearPasses: flip.clearNewNodes.length };
  });
  assert.equal(scheduled.clearPasses, 2, 'cell clears should be grouped within the eight-binding limit');
  for (const outcome of scheduled.outcomes) {
    assert.equal(outcome.incorrect, 0, 'compact dispatch must preserve pool addresses and sentinel cells');
    assert.deepEqual(outcome.args, outcome.expected);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await site.close();
}
