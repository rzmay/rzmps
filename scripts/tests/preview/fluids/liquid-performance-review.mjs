import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { startSiteDev } from '../../../site/dev.mjs';

const site = await startSiteDev({ port: 0, host: '127.0.0.1' });
let browser;
try {
  browser = await puppeteer.launch({ headless: true, args: ['--enable-unsafe-webgpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(240000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const outcomes = [];
  for (const depth of [2, 3]) {
    await page.goto(`http://127.0.0.1:${site.demo.httpServer.address().port}/@fs${
      path.resolve(import.meta.dirname, 'fixtures/fluid.html')}`
      + `?demoLiquid&profile=true&reviewGrid=${depth},4&reviewParticles=16000`);
    await page.waitForFunction(() => window.ready);
    outcomes.push(await page.evaluate(async () => {
      const { renderer, system, flip, scene, camera } = window.debugFluid;
      const surface = system.renderers.find(renderer => renderer.constructor.name === 'SurfaceRenderer');
      const compute = renderer.compute, timestampUID = renderer.backend.getTimestampUID;
      let stage = 'other', sequence = 0;
      const records = [];
      const classify = node => {
        const projection = flip.pressureProjection;
        if (node === flip.clearFieldsNode) return 'fieldClear';
        if (node === projection?.clearWorkFacesNode) return 'faceClear';
        if ([flip.workGrid?.resetNode, flip.workGrid?.snapshotNode, flip.workGrid?.particleNode,
          flip.workGrid?.allocateNode, flip.workGrid?.scheduleNode, flip.workGrid?.copySourceMaskNode]
          .includes(node)) return 'workGrid';
        if (node === flip.gatherNode) return 'particleToGrid';
        if (node === flip.forceNodeCompute) return 'forces';
        if (node === flip.transferNode) return 'gridToParticle';
        if (node === flip.separationNode || node === flip.separationApplyNode) return 'separation';
        if (node === flip.solidNode) return 'solid';
        if (projection?.pressureNodes.includes(node)) return 'pressure';
        if (node === projection?.beforeBuilds.get(flip.velocityBefore)
          || node === projection?.builds.get(flip.velocityNext)) return 'faceBuild';
        if ([projection?.divergenceNode, projection?.projectNode,
          projection?.centers.get(flip.velocityNext)].includes(node)) return 'projection';
        if (flip.spatialGrid?.buildNodes?.includes(node)) return 'particleGrid';
        return 'other';
      };
      renderer.compute = function (node, ...args) {
        const previous = stage;
        if (stage !== 'surface') stage = classify(node);
        try { return compute.call(this, node, ...args); } finally { stage = previous; }
      };
      renderer.backend.getTimestampUID = function (...args) {
        const uid = timestampUID.apply(this, args).replace(/:f(\d+)$/, `-pass${sequence++}:f$1`);
        records.push({ uid, stage });
        return uid;
      };
      const update = surface._updateGPU;
      surface._updateGPU = function (...args) {
        const previous = stage;
        stage = 'surface';
        try { return update.apply(this, args); } finally { stage = previous; }
      };
      const samples = [];
      const frames = 900;
      for (let frame = 0; frame < frames + 30; frame++) {
        records.length = 0;
        sequence = 0;
        const start = performance.now();
        system.advanceFrames(1, 1 / 60);
        const submissionMs = performance.now() - start;
        const computeMs = await renderer.resolveTimestampsAsync('compute');
        if (frame >= frames) {
          const groups = {};
          const timestamps = renderer.backend.timestampQueryPool.compute.timestamps;
          for (const { uid, stage } of records) groups[stage] = (groups[stage] ?? 0) + (timestamps.get(uid) ?? 0);
          await renderer.renderAsync(scene, camera);
          const renderMs = await renderer.resolveTimestampsAsync('render');
          samples.push({ computeMs, renderMs, submissionMs, ...groups });
        }
      }
      renderer.compute = compute;
      renderer.backend.getTimestampUID = timestampUID;
      surface._updateGPU = update;
      const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const timings = Object.fromEntries(Object.keys(samples[0]).map(key => [key, median(samples.map(s => s[key]))]));
      const attributes = new Set([
        flip.velocityCurrentAttribute, flip.velocityNextAttribute, flip.velocityBeforeAttribute,
        flip.pressureCurrentAttribute, flip.pressureNextAttribute, flip.divergenceAttribute, flip.solidAttribute,
        flip.pressureProjection.attribute, flip.pressureProjection.beforeAttribute]);
      const bricks = new Uint32Array(await renderer.getArrayBufferAsync(flip.workGrid.diagnosticsAttribute));
      const particles = (await system.selectiveReadback(20000, ['position'])).filter(({ particle }) => particle.alive);
      return { resolution: flip.resolution, cellSize: flip.cellSize, particles: particles.length, timings,
        activeBricks: bricks[0], totalBricks: flip.workGrid.brickCount,
        fieldBytes: [...attributes].reduce((sum, attribute) => sum + attribute.array.byteLength, 0),
        surface: await surface.readSurfaceDiagnostics() };
    }));
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(outcomes, null, 2));
  await writeFile('/tmp/rzmps-liquid-performance.json', JSON.stringify(outcomes, null, 2));
} finally { await browser?.close(); await site.close(); }
