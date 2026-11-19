import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, float, instanceIndex, uint, vec3, storage } from 'three/tsl';
import { Emitter, ParticleSystem, SurfaceRenderer, ColorOverLifetime, ScaleOverLifetime,
  buildSurfaceNets, buildMarchingCubes } from '@rzmps/rzmps';
const liquidFlowMaterial = new SurfaceRenderer.LiquidMaterial().compositeGPU;

const renderer = new WebGPURenderer({ trackTimestamp: true });
renderer.setSize(640, 480);
renderer.setPixelRatio(1);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color('#171b20');
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2));
const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(1, 3, 4);
scene.add(light);
const camera = new THREE.PerspectiveCamera(35, 640 / 480, 0.1, 100);
camera.position.set(0.8, 0.6, 5);
camera.lookAt(0, 0, 0);
const surface = new SurfaceRenderer({
  bounds: new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2)),
  voxelSize: 0.0625, particleRadius: 1, isoLevel: 0.2, maxActiveBricks: 512, maxTriangles: 20000,
  spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 0 },
  smoothingIterations: 0,
  material: new THREE.MeshStandardMaterial({ roughness: 0.24 }),
});
const system = new ParticleSystem({ gpuProcessing: true, maxParticles: 512, gravity: new THREE.Vector3(),
  emitters: [new Emitter({ tags: ['red', 'blue'], rate: 0, bursts: [{ time: 0, count: 512 }], initialValues: {
    lifetime: 100, scale: new THREE.Vector3(1, 1, 1), velocity: new THREE.Vector3(),
  } })], renderers: [surface],
});
scene.add(system);
await renderer.renderAsync(scene, camera);
system.advanceFrames(1, 1 / 60);

let seedNode, seedKey;
window.seedSurface = async (samples, diagnostics = true) => {
  const buffers = system.gpuSimulation._gpuBuffers;
  const key = JSON.stringify(samples);
  if (key !== seedKey) {
    seedNode?.dispose();
    seedKey = key;
    seedNode = Fn(() => {
    const p = buffers.storage.createParticle(undefined, true);
    p.alive.assign(0);
    samples.forEach((sample, index) => If(instanceIndex.equal(index), () => {
      p.alive.assign(1);
      p.position.assign(vec3(...sample.position));
      p.velocity.assign(vec3(...(sample.velocity ?? [0, 0, 0])));
      p.scale.assign(vec3(...(sample.scale ?? [1, 1, 1])));
      p.color.assign(vec3(...sample.color));
      p.alpha.assign(sample.alpha ?? 1);
      p.tagMask.assign(uint(sample.tagMask ?? 0));
      p.generation.assign(index + 1);
      p.lifetime.assign(100);
      p.time.assign(0);
      p.realtime.assign(0);
    }));
    buffers.storage.storeParticle(p);
    })().compute(buffers.count);
  }
  renderer.compute(seedNode);
  surface.updateGPU(buffers, system);
  await renderer.renderAsync(scene, camera);
  return diagnostics ? window.readSurface() : null;
};
window.readSurface = async () => {
  const helper = surface.surface;
  const read = async (attribute, Type = Float32Array) => new Type(await renderer.getArrayBufferAsync(attribute));
  const positions = await read(helper.positionAttribute);
  const normals = await read(helper.normalAttribute);
  const colors = await read(helper.colorAttribute);
  const velocities = await read(helper.flowAttribute);
  const vorticities = await read(helper.vorticityAttribute);
  const uniquePositions = new Map();
  const welded = new Map();
  const draw = await read(helper.drawAttribute, Uint32Array);
  const rawIndices = (await read(helper.indexAttribute, Uint32Array)).slice(0, draw[0]);
  // Both extractors use the same geometric weld tolerance for topology measurement.
  for (const index of new Set(rawIndices)) {
    const key = [...positions.slice(index * 4, index * 4 + 3)].map(value => Math.round(value * 1e6)).join(':');
    if (!uniquePositions.has(key)) uniquePositions.set(key, index);
    welded.set(index, uniquePositions.get(key));
  }
  const indices = rawIndices.map(index => welded.get(index));
  const edges = new Map();
  const components = new Map();
  const root = index => {
    let current = index;
    while (components.get(current) !== current) current = components.get(current);
    return current;
  };
  let invalid = 0, reversed = 0, red = 0, blue = 0, mixed = 0, volume = 0;
  let maxVelocityError = 0, maxCurl = 0, maxLinearError = 0, maxVelocityJump = 0;
  for (const index of new Set(indices)) {
    components.set(index, index);
    const p = index * 4;
    if (!positions.slice(p, p + 4).every(Number.isFinite) || positions[p + 3] !== 1) invalid++;
    const length = Math.hypot(...normals.slice(p, p + 3));
    if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-4) invalid++;
    if (!colors.slice(p, p + 4).every(Number.isFinite)
      || !velocities.slice(p, p + 4).every(Number.isFinite)
      || !vorticities.slice(p, p + 4).every(Number.isFinite)) invalid++;
    if (window.expectedVelocity) maxVelocityError = Math.max(maxVelocityError,
      Math.hypot(...velocities.slice(p, p + 3).map((value, axis) => value - window.expectedVelocity[axis])));
    if (window.expectedLinearVelocity) maxLinearError = Math.max(maxLinearError,
      Math.hypot(...velocities.slice(p, p + 3).map((value, axis) => value - positions[p + axis])));
    maxCurl = Math.max(maxCurl, Math.hypot(...vorticities.slice(p, p + 3)));
    if (colors[p] > colors[p + 2] * 1.5) red++;
    if (colors[p + 2] > colors[p] * 1.5) blue++;
    if (colors[p] > 0.1 && colors[p + 2] > 0.1) mixed++;
  }
  for (let i = 0; i < indices.length; i += 3) {
    const face = [...indices.slice(i, i + 3)];
    const points = face.map(index => new THREE.Vector3(...positions.slice(index * 4, index * 4 + 3)));
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
    volume += points[0].dot(points[1].clone().cross(points[2])) / 6;
    const shading = face.reduce((sum, index) => sum.add(new THREE.Vector3(...normals.slice(index * 4, index * 4 + 3))),
      new THREE.Vector3());
    if (normal.dot(shading) < -1e-8) reversed++;
    for (let edge = 0; edge < 3; edge++) {
      const a = face[edge], b = face[(edge + 1) % 3];
      const key = [Math.min(a, b), Math.max(a, b)].join(',');
      edges.set(key, (edges.get(key) ?? 0) + 1);
      components.set(root(a), root(b));
    }
  }
  const diagnostics = await surface.readSurfaceDiagnostics();
  let normalVariation = 0;
  for (const key of edges.keys()) {
    const [a, b] = key.split(',').map(Number);
    maxVelocityJump = Math.max(maxVelocityJump, Math.hypot(...velocities.slice(a * 4, a * 4 + 3)
      .map((value, axis) => value - velocities[b * 4 + axis])));
    normalVariation += new THREE.Vector3(...normals.slice(a * 4, a * 4 + 3))
      .distanceToSquared(new THREE.Vector3(...normals.slice(b * 4, b * 4 + 3)));
  }
  return { ...diagnostics, bounds: [diagnostics.bounds.min.toArray(), diagnostics.bounds.max.toArray()],
    volume: Math.abs(volume), normalVariation: normalVariation / Math.max(1, edges.size),
    weldedVertices: uniquePositions.size,
    invalid, reversed, red, blue, mixed, maxVelocityError, maxCurl, maxLinearError, maxVelocityJump,
    openEdges: [...edges.values()].filter(count => count !== 2).length,
    boundaryEdges: [...edges.values()].filter(count => count === 1).length,
    nonManifoldEdges: [...edges.values()].filter(count => count > 2).length,
    components: new Set([...components.keys()].map(root)).size, draw: [...draw],
    storageLimit: renderer.backend.device.limits.maxStorageBuffersPerShaderStage };
};
window.surfaceFixture = { renderer, scene, camera, surface, system, THREE, ColorOverLifetime, ScaleOverLifetime,
  buildSurfaceNets, buildMarchingCubes };
window.ready = true;

// Isolate reconstruction from particle integration, collision and liquid transfer.
window.reconstructSurface = async (samples, settings) => {
  const { flowMaterial, ...reconstruction } = settings;
  Object.assign(surface, reconstruction);
  window.lastSurfaceSettings = reconstruction;
  surface.materialCompositeGPU = flowMaterial ? liquidFlowMaterial : undefined;
  await window.seedSurface(samples, false);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  surface.benchmarks.start({ gpuTiming: true, maxSamples: 64 });
  let stage = 'other';
  const span = surface.benchmarks.span;
  surface.benchmarks.span = function (name, callback) {
    const previous = stage;
    stage = name;
    try { return span.call(this, name, callback); } finally { stage = previous; }
  };
  const timestampQuery = renderer.backend.initTimestampQuery;
  const timestamps = [];
  renderer.backend.initTimestampQuery = function (type, uid, descriptor) {
    const key = type === 'compute' ? uid.replace(/:f(\d+)$/, `-surface${timestamps.length}:f$1`) : uid;
    if (type === 'compute') timestamps.push({ uid: key, stage });
    return timestampQuery.call(this, type, key, descriptor);
  };
  const start = performance.now();
  try { surface.updateGPU(system.gpuSimulation._gpuBuffers, system); } finally {
    surface.benchmarks.span = span;
    renderer.backend.initTimestampQuery = timestampQuery;
  }
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const reconstructionFencedMs = performance.now() - start;
  const renderStart = performance.now();
  await renderer.renderAsync(scene, camera);
  await renderer.backend.device.queue.onSubmittedWorkDone();
  const renderFencedMs = performance.now() - renderStart;
  await renderer.resolveTimestampsAsync('compute');
  const resolved = renderer.backend.timestampQueryPool?.compute?.timestamps;
  const gpuStages = {};
  for (const name of ['anisotropy', 'surfaceBrickActivation', 'fieldReconstruction', 'surfaceVorticity',
    'fieldFiltering', 'surfaceExtraction', 'surfaceSmoothing', 'meshUpdate']) {
    const entries = timestamps.filter(item => item.stage === name);
    gpuStages[name] = resolved && entries.length && entries.every(item => resolved.has(item.uid))
      ? entries.reduce((sum, item) => sum + resolved.get(item.uid), 0) : null;
  }
  const result = await window.readSurface();
  surface.benchmarks.frame();
  return { ...result, fencedMs: reconstructionFencedMs + renderFencedMs, reconstructionFencedMs,
    renderFencedMs, gpuStages, timestampSupported: renderer.backend.trackTimestamp,
    stages: surface.benchmarks.snapshot() };
};

window.captureTeapot = async () => {
  const [{ default: createFluid }, { default: createScene }] = await Promise.all([
    import('../../../../../examples/experimental/flipFluid.js'),
    import('../../../../../examples/scenes/fluidTeapot.js'),
  ]);
  const temporaryScene = new THREE.Scene();
  const lifecycle = await createScene(temporaryScene);
  const liquid = await createFluid();
  liquid.gpuProcessing = true;
  for (const child of liquid.subSystems.keys()) { liquid.removeSubSystem(child); child.destroy(); }
  liquid.renderers.forEach(item => item.destroy());
  liquid.renderers = [];
  temporaryScene.userData.__rzmps_particleRoot.add(liquid);
  await renderer.renderAsync(temporaryScene, camera);
  await liquid.prepare(renderer);
  liquid.advanceFrames(360, 1 / 60);
  const live = await liquid.selectiveReadback(16000, ['position', 'velocity', 'scale', 'color']);
  const particles = live.filter(item => item.particle.alive).map(item => item.particle)
    .filter(particle => particle.position.y > -2.95 && particle.position.y < 0.2
      && Math.abs(particle.position.x) < 1.7 && Math.abs(particle.position.z) < 1.4);
  const bounds = new THREE.Box3().setFromPoints(particles.map(particle => particle.position));
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const scale = 2.4 / Math.max(size.x, size.y, size.z, 1e-6);
  const stride = Math.max(1, Math.ceil(particles.length / 256));
  const samples = particles.filter((_particle, i) => i % stride === 0).map(particle => ({
    position: particle.position.clone().sub(center).multiplyScalar(scale).toArray(),
    scale: particle.scale.clone().multiplyScalar(scale * Math.cbrt(stride)).toArray(),
    velocity: particle.velocity.toArray(), color: particle.color.toArray(),
  }));
  liquid.destroy();
  lifecycle.cleanup();
  return { samples, sourceParticles: particles.length, stride, scale };
};


window.testSurfaceComposites = async () => {
  const { ParticleSystemSerializer } = await import(
    '../../../src/gui/particle-system-gui/ParticleSystemSerializer.js');
  const originalMaterial = surface.material;
  surface.material = new SurfaceRenderer.LiquidMaterial({ flow: { roughness: [0.02, 0.7] } });
  surface.materialCompositeGPU = undefined;
  const code = new ParticleSystemSerializer({ system }).serializeParticleSystem();
  surface.material = originalMaterial;
  const samples = [{ position: [0, 0, 0], scale: [1, 1, 1], color: [1, 1, 1], velocity: [1, 2, 3] }];
  surface.materialCompositeGPU = (_source, _dest, context) => ({
    color: vec3(context.surfaceSpeed.div(4), 0, 0),
  });
  surface.materialComposite = (_source, _dest, context) => ({
    color: `vec3(${context.surfaceSpeed} / 4.0, 0.0, 0.0)`,
  });
  await window.seedSurface(samples, false);
  const pixel = canvas => {
    const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
    const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0);
    return [...context.getImageData(copy.width / 2, copy.height / 2, 1, 1).data];
  };
  const gpu = pixel(renderer.domElement);
  const helper = surface.surface;
  const geometry = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries({ position: helper.positionAttribute, normal: helper.normalAttribute,
    color: helper.colorAttribute, surfaceVelocity: helper.flowAttribute,
    surfaceVorticity: helper.vorticityAttribute })) {
    const data = new Float32Array(await renderer.getArrayBufferAsync(attribute));
    geometry.setAttribute(name, new THREE.BufferAttribute(data, 4));
  }
  const draw = new Uint32Array(await renderer.getArrayBufferAsync(helper.drawAttribute));
  geometry.setIndex(new THREE.BufferAttribute(
    new Uint32Array(await renderer.getArrayBufferAsync(helper.indexAttribute)).slice(0, draw[0]), 1));
  const webgl = new THREE.WebGLRenderer(); webgl.setSize(640, 480);
  const exported = new THREE.Mesh(geometry, surface.material);
  surface.mesh.visible = false;
  scene.add(exported);
  webgl.render(scene, camera);
  const gl = pixel(webgl.domElement);
  exported.removeFromParent(); geometry.dispose(); webgl.dispose();
  surface.mesh.visible = true;
  surface.materialCompositeGPU = undefined;
  surface.materialComposite = undefined;
  // Restore the owning renderer after the explicit WebGL export comparison.
  await renderer.renderAsync(scene, camera);
  return { gpu, gl, code };
};


window.testLiquidMaterial = async () => {
  const { MeshBasicNodeMaterial } = await import('three/webgpu');
  const samples = [{ position: [0, 0, 0], scale: [1, 1, 1], color: [1, 1, 1] }];
  const liquid = new SurfaceRenderer.LiquidMaterial({ flow: {
    gradient: ['red', '#00ff00'], roughness: t => 0.02 + 0.68 * t,
    normalStrength: [0, 0],
  } });
  surface.material = new MeshBasicNodeMaterial();
  surface.materialComposite = undefined;
  const pixels = {};
  for (const [name, speed, curl, deformation, channel] of [
    ['calm', 0, 0, 0, 'color'], ['moving', 3, 0, 0, 'color'],
    ['deforming', 0, 0, 6, 'color'], ['rotating', 0, 20, 0, 'color'],
    ['smooth', 0, 0, 0, 'roughness'], ['rough', 0, 0, 6, 'roughness'],
  ]) {
    surface.materialCompositeGPU = (source, dest, context) => {
      const result = liquid.compositeGPU(source, dest, { ...context,
        surfaceSpeed: float(speed), surfaceVorticityMagnitude: float(curl), surfaceDeformation: float(deformation) });
      return { color: channel === 'color' ? result.color : vec3(result.roughness) };
    };
    await window.seedSurface(samples, false);
    const copy = document.createElement('canvas'); copy.width = 640; copy.height = 480;
    const context = copy.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
    pixels[name] = [...context.getImageData(320, 240, 1, 1).data];
  }
  // The actual built-in material must detect setFlow without reallocating surface resources.
  surface.materialCompositeGPU = undefined;
  surface.material = liquid;
  await window.seedSurface(samples, false);
  const geometry = surface.surface;
  const oldCallback = surface.material.compositeGPU;
  surface.material.setFlow({ normalStrength: [0.04, 0.25], gradient: ['blue', 'white'] });
  await window.seedSurface(samples, false);
  pixels.reusedGeometry = geometry === surface.surface;
  pixels.replacedCallback = oldCallback !== surface.material.compositeGPU;
  liquid.dispose();
  return pixels;
};

window.testAutomaticSurfaceGrowth = async () => {
  const test = new SurfaceRenderer({ bounds: surface.bounds.clone(), voxelSize: 0.0625,
    particleRadius: 0.65, smoothingIterations: 0, fieldSmoothingIterations: 0, fieldClosing: 0 });
  system.addRenderer(test);
  const buffers = system.gpuSimulation._gpuBuffers;
  const seed = Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    particle.position.assign(vec3(float(instanceIndex.mod(8)), float(instanceIndex.div(8).mod(8)),
      float(instanceIndex.div(64).mod(8))).sub(3.5).mul(0.45));
    particle.scale.assign(vec3(0.5)); particle.alive.assign(1);
    buffers.storage.storeParticle(particle);
  })().compute(buffers.count);
  renderer.compute(seed);
  const first = performance.now();
  test.updateGPU(buffers, system);
  const before = await test.readSurfaceDiagnostics();
  const current = test.surface;
  const growthRequest = performance.now();
  test.updateGPU(buffers, system);
  const retainedWhilePreparing = test.surface === current;
  const allocation = test.allocation;
  await allocation.whenPrepared();
  const prepared = performance.now();
  const swapStart = performance.now();
  test.updateGPU(buffers, system);
  const swapFrameCpuMs = performance.now() - swapStart;
  const after = await test.readSurfaceDiagnostics();
  const result = { before, after, retainedWhilePreparing, swapped: test.surface !== current,
    firstFrameFencedMs: growthRequest - first, preparationWallMs: prepared - growthRequest,
    swapFrameCpuMs, lifecycle: allocation.metrics,
    temporaryPeakBytes: before.allocatedBytes + after.allocatedBytes };
  system.removeRenderer(test); test.destroy(); seed.dispose();
  return result;
};

window.testSaturatedSupport = async () => {
  const samples = [];
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++)
    samples.push({ position: [x * 0.04, y * 0.04, z * 0.04], scale: [0.2, 0.2, 0.2], color: [1, 1, 1] });
  surface.anisotropy = 0;
  await window.seedSurface(samples, false);
  const helper = surface.surface, grid = helper.queryGrid;
  const attribute = new StorageBufferAttribute(new Float32Array(helper.projection.capacity * 12), 4);
  const original = grid.forEachParticleInRadius;
  let reference;
  grid.forEachParticleInRadius = function (point, radius, visitor, options) {
    return original.call(this, point, radius, visitor, { ...options, stopWhen: undefined });
  };
  try {
    reference = helper.kernels.build(grid, storage(attribute, 'vec4', attribute.count), false);
    // Fn callbacks are generated lazily on first compute; keep the reference override until then.
    renderer.compute(reference);
  } finally { grid.forEachParticleInRadius = original; }
  try {
    const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
    const optimized = await read(helper.kernelAttribute), full = await read(attribute);
    const bulk = value => THREE.MathUtils.smoothstep(value, surface.dropletSupportMin, surface.dropletSupportMax);
    let maxError = 0, shortCircuited = 0;
    for (let i = 0; i < samples.length * 12; i++) {
      maxError = Math.max(maxError, Math.abs(i % 12 === 7
        ? bulk(optimized[i]) - bulk(full[i]) : optimized[i] - full[i]));
      if (i % 12 === 7 && full[i] > optimized[i] + 1e-3) shortCircuited++;
    }
    return { maxError, shortCircuited };
  } finally { reference.dispose(); attribute.dispose(); }
};

window.compareAnisotropicKernels = async () => {
  const modes = {
    reference: { supportSizedBins: false, sharedMoments: false, convergedEigen: false },
    final: { supportSizedBins: false, sharedMoments: true, convergedEigen: true },
  };
  const contact = document.createElement('canvas'); contact.width = 640; contact.height = 960;
  const context = contact.getContext('2d'), results = [];
  const read = async attribute => new Float32Array(await renderer.getArrayBufferAsync(attribute));
  const snapshot = async () => {
    const helper = surface.surface;
    const [field, kernels, positions, normals, draw] = await Promise.all([
      read(helper.fieldAttribute), read(helper.kernelAttribute),
      read(helper.positionAttribute), read(helper.normalAttribute),
      renderer.getArrayBufferAsync(helper.drawAttribute),
    ]);
    const indices = new Uint32Array(await renderer.getArrayBufferAsync(helper.indexAttribute));
    const used = new Set(indices.subarray(0, new Uint32Array(draw)[0]));
    const geometry = new Map([...used].map(vertex => {
      const point = positions.slice(vertex * 4, vertex * 4 + 3);
      // A dual vertex is tied to a world-space cell, not an atomic output/resident address.
      const cell = [...point].map((value, axis) => Math.floor(
        (value - helper.bounds.min.getComponent(axis)) / surface.voxelSize + 1e-5)).join(',');
      return [cell, { position: point, normal: normals.slice(vertex * 4, vertex * 4 + 3) }];
    }));
    if (geometry.size !== used.size) throw new Error('Dual vertices must have unique logical cells.');
    return { field: field.subarray(0, helper.grid.cellCount * 4), kernels, geometry,
      indices: used, triangles: new Uint32Array(draw)[0] / 3 };
  };
  for (const [row, kind] of ['calm', 'flowing', 'stretched', 'splashing'].entries()) {
    const particles = [];
    for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
      const point = [x * 0.14, y * 0.14, z * 0.14];
      if (kind === 'stretched') { point[0] *= 2; point[1] *= 0.4; }
      if (kind === 'splashing') point[1] += 0.2 * Math.sin(x + z);
      particles.push({ position: point, scale: [0.24, 0.24, 0.24], color: [0.2, 0.5, 1],
        velocity: kind === 'flowing' ? [3, 0, 0] : [0, 0, 0] });
    }
    const snapshots = [];
    for (const [column, mode] of ['reference', 'final'].entries()) {
      surface.anisotropy = 0.35; surface.anisotropyMaxStretch = 1.5;
      surface.kernelOptimization = modes[mode];
      if (surface.surface) { surface.surface.kernelKey = ''; surface.surface.queryVersion = -1; }
      await window.seedSurface(particles, false);
      snapshots.push(await snapshot());
      await renderer.renderAsync(scene, camera);
      context.drawImage(renderer.domElement, column * 320, row * 240, 320, 240);
    }
    const [a, b] = snapshots;
    let fieldError = 0, fieldSize = 0, positionError = 0, normalError = 0, shapeError = 0;
    for (let i = 0; i < a.field.length; i++) {
      fieldError += Math.abs(a.field[i] - b.field[i]); fieldSize += Math.abs(a.field[i]);
    }
    for (const [cell, first] of a.geometry) {
      const second = b.geometry.get(cell);
      if (!second) throw new Error(`Missing reconstructed dual cell ${cell}`);
      positionError = Math.max(positionError, Math.hypot(...first.position.map((value, i) => value - second.position[i])));
      normalError = Math.max(normalError, Math.hypot(...first.normal.map((value, i) => value - second.normal[i])));
    }
    // Axis signs/order may change in an eigenspace. Compare the represented quadratic form A^T A.
    for (let p = 0; p < particles.length; p++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let x = 0, y = 0;
      for (let axis = 0; axis < 3; axis++) {
        x += a.kernels[p * 12 + axis * 4 + i] * a.kernels[p * 12 + axis * 4 + j];
        y += b.kernels[p * 12 + axis * 4 + i] * b.kernels[p * 12 + axis * 4 + j];
      }
      shapeError = Math.max(shapeError, Math.abs(x - y));
    }
    results.push({ kind, fieldRelativeError: fieldError / Math.max(fieldSize, 1e-12), positionError, normalError,
      shapeError, triangles: [a.triangles, b.triangles], vertices: [a.indices.size, b.indices.size] });
  }
  contact.id = 'anisotropic-quality'; document.body.append(contact);
  return results;
};

window.compareSurfaceQueryCellSizes = async () => {
  const particles = [];
  for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++)
    particles.push({ position: [x * 0.14, y * 0.14, z * 0.14], scale: [0.24, 0.24, 0.24], color: [0.2, 0.5, 1] });
  surface.anisotropy = 0.35;
  await window.seedSurface(particles, false);
  const snapshots = [];
  for (const width of [0.03125, 0.25]) {
    const helper = surface.surface;
    helper.queryGrid.setOptions({ autoVolumeQuality: false, volumeQuality: width * helper.queryGrid.cellsPerAxis });
    await window.seedSurface(particles, false);
    snapshots.push({ width: helper.queryGrid.cellSize,
      field: new Float32Array(await renderer.getArrayBufferAsync(helper.fieldAttribute)),
      diagnostics: await surface.readSurfaceDiagnostics() });
  }
  let error = 0, size = 0;
  const [a, b] = snapshots;
  for (let i = 0; i < a.field.length; i++) {
    error += Math.abs(a.field[i] - b.field[i]); size += Math.abs(a.field[i]);
  }
  return { widths: snapshots.map(sample => sample.width), relativeFieldError: error / Math.max(size, 1e-12),
    triangles: snapshots.map(sample => sample.diagnostics.triangles),
    clipping: snapshots.map(sample => sample.diagnostics.clippedParticles),
    overflow: snapshots.map(sample => sample.diagnostics.overflowedTriangles) };
};
