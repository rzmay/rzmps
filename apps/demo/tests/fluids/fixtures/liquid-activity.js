import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, storage, vec3, vec4, uniform, float, uint, ivec3, instanceIndex, If } from 'three/tsl';
import { Emitter, FLIPSimulation, ParticleSystem, SpriteRenderer, SurfaceRenderer, Textures } from '@rzmps/rzmps';
import LiquidSurface from '../../../../../packages/rzmps/src/rendering/gpu/LiquidSurface.ts';
import { applySurfaceMaterial } from '../../../../../packages/rzmps/src/rendering/compositing/applySurfaceMaterial.ts';

const renderer = new WebGPURenderer();
renderer.setSize(1120, 240); renderer.setClearColor('#222222');
document.body.append(renderer.domElement);
await renderer.init();
const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
const surface = new LiquidSurface({ bounds, voxelSize: 0.25, maxActiveBricks: 2, maxTriangles: 512,
  spatialGridOptions: {}, particleRadius: 1.55, influenceRadius: 2.2, anisotropy: 0,
  anisotropyRadius: 2, anisotropyMinNeighbors: 6, anisotropyMaxStretch: 2,
  dropletSupportMin: 1, dropletSupportMax: 4, fieldSmoothingIterations: 1,
  fieldSmoothing: 0.2, fieldClosing: 0, flowSmoothing: 0.8,
  velocityDetailRange: [0.5, 3], vorticityDetailRange: [4, 20],
}, renderer);
const { grid } = surface;
renderer.compute(Fn(() => { grid.pages.element(0).assign(1); grid.slots.element(0).assign(1); })().compute(1));
grid.updateDispatch(renderer);
const matrix = uniform(new THREE.Matrix3()), translation = uniform(new THREE.Vector3());
const fill = grid.compute(index => {
  const point = vec3(grid.coordinate(index)).mul(0.25).sub(1);
  const velocity = matrix.mul(point).add(translation);
  surface.field.element(index).assign(vec4(1));
  surface.flow.element(index).assign(vec4(velocity, 1));
});
const material = new SurfaceRenderer.LiquidMaterial({ transmission: 0, flow: {
  gradient: ['#2277aa', '#ffffff'], roughness: [0.05, 0.9],
  normalStrength: [0, 0], distortion: [0, 0], advection: [0, 0],
} });
const curlNode = grid.compute(index => surface.reconstructCurl(index));
const query = uniform(new THREE.Vector3(4, 4, 4));
const attribute = new StorageBufferAttribute(new Float32Array(12), 4), output = storage(attribute, 'vec4', 3);
const sample = Fn(() => {
  const metrics = surface.interpolate(surface.curl, query).toVar();
  const velocity = surface.interpolate(surface.flow, query).xyz;
  const input = { color: vec3(1), opacity: float(1), roughness: float(0), metalness: float(0), normal: vec3(0, 0, 1) };
  const result = material.compositeGPU(input, input, { geometricNormal: input.normal,
    surfaceVelocity: velocity, surfaceSpeed: velocity.length(), surfaceVorticity: metrics.xyz,
    surfaceVorticityMagnitude: metrics.xyz.length(), surfaceDeformation: metrics.w });
  output.element(0).assign(metrics);
  output.element(1).assign(vec4(result.color, result.roughness));
  output.element(2).assign(vec4(velocity, velocity.length()));
})().compute(1);

window.runActivityFixtures = async () => {
  const cases = [
    ['calm', [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['translation', [0, 0, 0, 0, 0, 0, 0, 0, 0], [12, -3, 7]],
    ['moving-container', [0, 0, 0, 0, 0, 0, 0, 0, 0], [12, -3, 7]],
    ['shear', [0, 4, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['rigid-rotation', [0, -1, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['churning', [0, -6, 0, 6, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['breaking', [6, -6, 0, 6, -6, 0, 0, 0, 0], [0, 0, 0]],
    ['translated-shear', [0, 4, 0, 0, 0, 0, 0, 0, 0], [12, -3, 7]],
  ];
  const results = [], scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight('white', 2));
  const light = new THREE.DirectionalLight('white', 2); light.position.set(1, 2, 3); scene.add(light);
  const camera = new THREE.OrthographicCamera(-4, 4, 0.85, -0.85, 0.1, 20); camera.position.z = 5;
  for (const [name, gradient, drift] of cases) {
    matrix.value.set(...gradient); translation.value.fromArray(drift);
    renderer.compute(fill); renderer.compute(curlNode); renderer.compute(sample);
    const data = [...new Float32Array(await renderer.getArrayBufferAsync(attribute))];
    results.push({ name, curl: data.slice(0, 3), deformation: data[3], color: data.slice(4, 7),
      roughness: data[7], speed: data[11] });
    const geometry = new THREE.PlaneGeometry(0.85, 1.1), count = geometry.attributes.position.count;
    geometry.setAttribute('surfaceVelocity', new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => [...drift, 1]).flat(), 4));
    geometry.setAttribute('surfaceVorticity', new THREE.Float32BufferAttribute(
      Array.from({ length: count }, () => data.slice(0, 4)).flat(), 4));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
    const copy = material.clone(); applySurfaceMaterial(copy, true, copy.compositeGPU);
    const mesh = new THREE.Mesh(geometry, copy); mesh.position.x = results.length - 4.5; scene.add(mesh);
  }
  await renderer.renderAsync(scene, camera);
  return results;
};

// Hold neighborhood support fixed so only reconstructed surface deformation controls eligibility.
window.runFoamFixtures = async () => {
  const fillFoam = grid.compute(index => {
    const point = vec3(grid.coordinate(index)).mul(0.25).sub(1);
    const density = float(0.2).sub(point.y.mul(0.1));
    surface.field.element(index).assign(vec4(1, 1, 1, density));
    surface.flow.element(index).assign(vec4(matrix.mul(point).add(translation).mul(density), density));
  });
  surface.bindSurfaceQuery(surface.surfaceQuery, new THREE.Matrix4(), 1 / 60);
  const condition = FLIPSimulation.FoamCondition({ samplerGPU: surface.sampleSurfaceGPU, minimumDeformity: 0.5 });
  const context = { system: { getSimulationToWorldMatrix: () => new THREE.Matrix4() },
    spatialGrid: { forEachParticleInRadius(_point, _radius, visit) {
      for (let i = 1; i <= 3; i++) visit({ index: uint(i), generation: uint(1) });
    } } };
  const testFoam = Fn(() => {
    const particle = { position: vec3(0), velocity: translation, speed: float(1), scale: vec3(0.1),
      realtime: float(1000), index: uint(0), generation: uint(1) };
    const selected = condition(particle, float(1 / 60), context);
    const sample = surface.sampleSurfaceGPU(particle.position);
    output.element(0).assign(vec4(sample.deformation, float(selected), float(sample.valid), 0));
  })().compute(1);
  const rows = [];

  for (const [name, gradient, drift] of [
    ['calm', [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['translation', [0, 0, 0, 0, 0, 0, 0, 0, 0], [12, -3, 7]],
    ['rotation', [0, -1, 0, 1, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['shear', [0, 4, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0]],
    ['translated-shear', [0, 4, 0, 0, 0, 0, 0, 0, 0], [12, -3, 7]],
  ]) {
    matrix.value.set(...gradient); translation.value.fromArray(drift);
    renderer.compute(fillFoam); renderer.compute(curlNode); renderer.compute(testFoam);
    const data = new Float32Array(await renderer.getArrayBufferAsync(attribute));
    rows.push({ name, deformation: data[0], selected: data[1], valid: data[2] });
  }

  return rows;
};

// Generic preparation must bind allocation diagnostics to the same storage used by simulation.
window.runPreparedCountFixture = async () => {
  const particles = new ParticleSystem({ maxParticles: 256, duration: 0, looping: true, gravityModifier: 0,
    emitters: [new Emitter({ rate: 60, initialValues: { lifetime: 10, scale: 0.05 } })],
    renderers: [new SpriteRenderer(Textures.Circle, { children: { count: 3, radius: 0.02 } })] });
  particles.name = 'Foam count fixture';
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.z = 5; scene.add(particles);

  try {
    await particles.prepare(renderer);
    await renderer.renderAsync(scene, camera);
    for (let frame = 0; frame < 60; frame++) particles.advanceFrames(1, 1 / 60);
    await renderer.renderAsync(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 260));
    particles.advanceFrames(1, 1 / 60);
    await renderer.renderAsync(scene, camera);
    const buffers = particles.gpuParticleBuffers;
    const data = new Uint32Array(await renderer.getArrayBufferAsync(buffers.attributes.uintData));
    let live = 0;
    for (let slot = 0; slot < buffers.count; slot++) if (data[slot * 4]) live++;
    particles.benchmarks.snapshot(); // Request the asynchronous renderer-child counters as the profiler does.
    await renderer.backend.device.queue.onSubmittedWorkDone();
    await new Promise(resolve => setTimeout(resolve, 0));
    return { live, gpuActive: particles.isGPUProcessingActive, snapshot: particles.benchmarks.snapshot() };
  } finally {
    scene.remove(particles); particles.destroy();
  }
};
window.traceSupportActivity = async () => {
  matrix.value.set(0, 0, 0, 0, 0, 0, 0, 0, 0); translation.value.set(0, 0, 0);
  const weight = uniform(0);
  const patch = Fn(() => {
    const address = grid.index(ivec3(5, 4, 4));
    surface.field.element(address).assign(vec4(0, 0, 0, weight));
    surface.flow.element(address).assign(vec4(0, weight.mul(12), 0, 0));
  })().compute(1);
  const rows = [];
  for (const support of [0, 0.99e-8, 1.01e-8, 0.99e-8, 0, 0.001, 0.005, 0.01]) {
    weight.value = support;
    renderer.compute(fill); renderer.compute(patch); renderer.compute(curlNode); renderer.compute(sample);
    const result = [...new Float32Array(await renderer.getArrayBufferAsync(attribute))];
    const raw = new Float32Array(await renderer.getArrayBufferAsync(surface.fieldAttribute));
    const pages = new Uint32Array(await renderer.getArrayBufferAsync(grid.pagesAttribute));
    const neighbors = [[5, 4, 4], [3, 4, 4], [4, 5, 4], [4, 3, 4], [4, 4, 5], [4, 4, 3]];
    const addresses = neighbors.map(([x, y, z]) => x + 8 * (y + 8 * z));
    const weights = addresses.map(index => raw[index * 4 + 3]);
    rows.push({ frame: rows.length, support, coordinate: [4, 4, 4], position: [0, 0, 0], centerVelocity: [0, 0, 0],
      neighborVelocities: addresses.map((index, i) => [...raw.slice((grid.cellCount + index) * 4,
        (grid.cellCount + index) * 4 + 3)].map(value => value / Math.max(weights[i], 1e-8))),
      neighborSupport: weights, resident: neighbors.map(() => pages[0] !== 0),
      deformation: result[3], vorticity: result.slice(0, 3), color: result.slice(4, 7), roughness: result[7] });
  }
  patch.dispose(); return rows;
};
window.traceMovingQuery = async () => {
  matrix.value.set(0, 4, 0, 0, 0, 0, 0, 0, 0); translation.value.set(12, -3, 7);
  renderer.compute(fill); renderer.compute(curlNode);
  const rows = [];
  for (let i = 0; i <= 64; i++) {
    query.value.set(2.5 + i / 32, 4, 4);
    renderer.compute(sample);
    const result = [...new Float32Array(await renderer.getArrayBufferAsync(attribute))];
    rows.push({ coordinate: query.value.toArray(), deformation: result[3], curl: result.slice(0, 3) });
  }
  query.value.set(4, 4, 4); return rows;
};
window.ready = true;

window.traceBrickActivity = async () => {
  const view = new LiquidSurface({ ...surface.options, maxActiveBricks: 8,
    bounds: new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2)),
  }, renderer);
  const grid = view.grid, zeroRight = uniform(0);
  renderer.compute(Fn(() => {
    grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
    grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
  })().compute(8));
  grid.updateDispatch(renderer);
  const fill = grid.compute(index => {
    const c = grid.coordinate(index), point = vec3(c).mul(0.25).sub(2);
    const weight = c.x.greaterThanEqual(8).and(zeroRight.greaterThan(0)).select(float(0), float(1));
    view.field.element(index).assign(vec4(1, 1, 1, 1).mul(weight));
    view.flow.element(index).assign(vec4(vec3(point.y.mul(4).add(12), -3, 7).mul(weight), weight));
  });
  const curl = grid.compute(index => view.reconstructCurl(index));
  const attribute = new StorageBufferAttribute(new Float32Array(65 * 4), 4), result = storage(attribute, 'vec4', 65);
  const sample = Fn(() => {
    const point = vec3(float(instanceIndex).div(32).add(7), 4, 4);
    result.element(instanceIndex).assign(view.interpolate(view.curl, point));
  })().compute(65);
  const read = async () => {
    renderer.compute(curl); renderer.compute(sample);
    return [...new Float32Array(await renderer.getArrayBufferAsync(attribute))];
  };
  try {
    renderer.compute(fill); const resident = await read();
    const remove = Fn(() => {
      If(instanceIndex.mod(2).equal(1), () => grid.pages.element(instanceIndex).assign(0));
    })().compute(8);
    renderer.compute(remove); const missing = await read(); remove.dispose();
    const restore = Fn(() => grid.pages.element(instanceIndex).assign(instanceIndex.add(1)))().compute(8);
    renderer.compute(restore); restore.dispose(); zeroRight.value = 1;
    renderer.compute(fill); const empty = await read();
    return { resident, missing, empty };
  } finally { fill.dispose(); curl.dispose(); sample.dispose(); attribute.dispose(); view.dispose(); }
};
