import * as THREE from 'three';
import { float, vec3 } from 'three/tsl';
import { LightingGrid } from '@rzmps/rzmps';
import { passTimer } from './volume-quality.js';
import createColorLights from '../../../../../examples/scenes/colorLights.js';

const relative = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-4);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Frozen-field continuity and full-frame timing; source evolution/readback are outside timed intervals. */
export async function measureLightingContinuity({ extent = 1, frameCount = 32, pixelRatio = 1, width = 400 } = {}) {
  const { renderer, scene, camera, system, volume, source, bounds, position, sample, clearLights }
    = window.lightingFixture;
  bounds.min.setScalar(-extent); bounds.max.setScalar(extent); source.field.version++;
  renderer.setPixelRatio(pixelRatio); renderer.setSize(width, width * 0.75);
  const device = renderer.backend.device, timer = passTimer(device, renderer.backend, () => 'lighting');
  const configurations = [
    { name: 'original', options: { levels: 3, directions: 6, samplesPerInterval: 4 } },
    { name: 'higher', options: { levels: 3, directions: 12, samplesPerInterval: 8, cellSize: 0.25 } },
    { name: 'reference', options: { levels: 3, directions: 24, samplesPerInterval: 16, cellSize: 0.125 } },
  ];
  const results = [];
  const imageSeries = [];
  try {
    for (const { name, options } of configurations) {
      clearLights(); scene.environment = null; position.value.set(0, 0, 0);
      const grid = new LightingGrid({ ...options, ambient: 'black', maxDistance: 4 });
      const point = new THREE.PointLight('white', 1, 0, 2); scene.add(point);
      const trajectory = [];
      for (let i = 0; i < 41; i++) {
        const distance = 0.35 + i * 0.05;
        point.position.set(distance, 0, 0);
        grid.update(renderer, scene, bounds);
        trajectory.push({ distance, radiance: (await sample(grid, true))[0] });
      }
      point.distance = 1; point.position.set(0.9, 0, 0); grid.update(renderer, scene, bounds);
      const insideRange = (await sample(grid, true))[0];
      point.position.x = 1.2; grid.update(renderer, scene, bounds);
      const outsideRange = (await sample(grid, true))[0];
      point.position.x = 3; grid.update(renderer, scene, bounds);
      const distant = (await sample(grid, true))[0];
      grid.dispose(); clearLights();

      // Render the actual moving-light scene against an unchanged volume and camera.
      const moving = createColorLights(scene);
      volume.lightingGridOptions = { ...options, maxDistance: 16 };
      system.updateRenderers(false); moving.update(0);
      for (let i = 0; i < 3; i++) await renderer.renderAsync(scene, camera);
      await device.queue.onSubmittedWorkDone();
      const frames = [], images = [], image = document.createElement('canvas'); image.width = 400; image.height = 300;
      const context = image.getContext('2d');
      const create = device.createComputePipeline.bind(device);
      const createAsync = device.createComputePipelineAsync.bind(device);
      let pipelines = 0;
      device.createComputePipeline = (...args) => { pipelines++; return create(...args); };
      device.createComputePipelineAsync = (...args) => { pipelines++; return createAsync(...args); };
      for (let i = 0; i < frameCount; i++) {
        moving.update(1 / 60);
        timer.start(); const start = performance.now();
        await renderer.renderAsync(scene, camera);
        const cpuMs = performance.now() - start, gpu = await timer.finish();
        const fencedWallMs = performance.now() - start;
        context.drawImage(renderer.domElement, 0, 0, 400, 300);
        const pixels = context.getImageData(160, 100, 80, 100).data;
        let energy = 0, squaredDelta = 0, maximumDelta = 0;
        const previous = images.at(-1);
        for (let j = 0; j < pixels.length; j++) {
          if (j % 4 === 3) continue;
          energy += pixels[j];
          const delta = previous ? Math.abs(pixels[j] - previous[j]) : 0;
          squaredDelta += delta ** 2; maximumDelta = Math.max(maximumDelta, delta);
        }
        images.push(new Uint8Array(pixels));
        frames.push({ cpuMs, fencedWallMs, computeGPUms: gpu.computeGPUms, renderGPUms: gpu.renderGPUms,
          totalGPUms: gpu.totalGPUms, energy, pixelRMSE: Math.sqrt(squaredDelta / (pixels.length * 0.75)),
          maximumPixelDelta: maximumDelta });
      }
      device.createComputePipeline = create; device.createComputePipelineAsync = createAsync;
      imageSeries.push(images);
      moving.cleanup(); volume.lightingGridOptions = undefined; system.updateRenderers(false);

      // Fixed physical density and lights, only the logical lighting rectangle changes.
      const stable = new LightingGrid({ ...options, ambient: 'black', maxDistance: 8 });
      point.distance = 0; point.position.set(0.9, 0.6, 0); scene.add(point);
      const owner = {}, extinctionGPU = p => p.abs().lessThan(vec3(0.8)).all().select(float(0.5), float(0));
      const domain = bounds.clone().expandByScalar(1), domainSamples = [];
      for (let i = 0; i < 9; i++) {
        domain.max.x = 2 + i * 0.125;
        stable.update(renderer, scene, domain, { owner, version: 0, extinctionGPU });
        domainSamples.push((await sample(stable, true))[0]);
      }
      stable.dispose(); clearLights();
      results.push({ name, trajectory, insideRange, outsideRange, distant, frames, domainSamples, pipelines,
        extent, frameCount, pixelRatio, width,
        medianComputeGPUms: median(frames.map(frame => frame.computeGPUms)),
        medianRenderGPUms: median(frames.map(frame => frame.renderGPUms)),
        maxTemporalChange: Math.max(...frames.slice(1).map((frame, i) => relative(frame.energy, frames[i].energy))),
        maxDomainChange: Math.max(...domainSamples.slice(1).map((value, i) => relative(value, domainSamples[i]))),
        maxOracleError: Math.max(...trajectory.map(value => relative(value.radiance, 1 / value.distance ** 2))) });
    }
  } finally { timer.dispose(); }
  const reference = imageSeries.at(-1);
  for (let configuration = 0; configuration < results.length; configuration++) {
    const rmse = imageSeries[configuration].map((image, frame) => {
      let error = 0;
      for (let pixel = 0; pixel < image.length; pixel++) {
        if (pixel % 4 !== 3) error += (image[pixel] - reference[frame][pixel]) ** 2;
      }
      return Math.sqrt(error / (image.length * 0.75));
    });
    results[configuration].medianReferenceRMSE = median(rmse);
  }
  return results;
}

/** Compare rendering features against one frozen field; exclude warmup, readback and graph compilation. */
export async function measureVolumeFeatures() {
  const { renderer, scene, camera, system, volume } = window.lightingFixture;
  const timer = passTimer(renderer.backend.device, renderer.backend, () => 'volume');
  const results = [];
  try {
    for (const [name, lighting, downsample, noise, anisotropy] of [
      ['unlit', false, 1, 0, 0], ['lit', true, 1, 0, 0], ['masked', true, 1, 2, 0],
      ['half-resolution', true, 2, 2, 0], ['directional', true, 1, 2, 0.3],
    ]) {
      Object.assign(volume, { downsample, dynamicResolution: false, densityNoiseStrength: noise, anisotropy,
        lightingGridOptions: lighting
          ? { cellSize: 0.25, directions: 12, samplesPerInterval: 8, maxDistance: 16 } : undefined });
      system.updateRenderers(false);
      for (let i = 0; i < 3; i++) await renderer.renderAsync(scene, camera);
      await renderer.backend.device.queue.onSubmittedWorkDone();
      const frames = [];
      for (let i = 0; i < 12; i++) {
        timer.start(); const start = performance.now();
        await renderer.renderAsync(scene, camera);
        const cpuMs = performance.now() - start;
        frames.push({ cpuMs, ...await timer.finish() });
      }
      results.push({ name, frames, medianCPUms: median(frames.map(row => row.cpuMs)),
        medianComputeGPUms: median(frames.map(row => row.computeGPUms)),
        medianRenderGPUms: median(frames.map(row => row.renderGPUms)) });
    }
  } finally { timer.dispose(); }
  return results;
}
