import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, float, storage, uniform, vec4 } from 'three/tsl';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import { LightingGrid, Module, ParticleSystem, VolumeRenderer } from '@rzmps/rzmps';
import { passTimer } from './volume-quality.js';
import createColorLights from '../../../../../examples/scenes/colorLights.js';
import createStudio from '../../../../../examples/scenes/ferndaleStudio.js';

const renderer = new WebGPURenderer({ trackTimestamp: true });
renderer.setSize(400, 300); renderer.setPixelRatio(1); renderer.setClearColor(0);
await renderer.init(); document.body.append(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 30);
camera.position.set(0, 0, 5);
const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
const source = new Module(() => {});
source.field = { data: new Float32Array(8 ** 3).fill(0.5), bounds, resolution: new THREE.Vector3(8, 8, 8), version: 0 };
source.getVolumeField = () => source.field;
const volume = new VolumeRenderer({ generateChildren: false, dynamicResolution: false, steps: 32,
  samplesPerVoxel: 1, opacity: 0.4, densityMapping: 'Linear', jitter: false, color: 'white' });
const system = new ParticleSystem({ emitters: [], modules: [source], renderers: [] });
scene.add(system); await renderer.renderAsync(scene, camera); system.addRenderer(volume);
const output = new StorageBufferAttribute(new Float32Array(4), 4), data = storage(output, 'vec4', 1);
const position = uniform(new THREE.Vector3()), view = uniform(new THREE.Vector3(0, 0, -1)), g = uniform(0);
const fence = () => renderer.backend.device.queue.onSubmittedWorkDone();
const assert = (value, message) => { if (!value) throw new Error(message); };
const close = (a, b, epsilon = 0.04) => Math.abs(a - b) <= epsilon;
const sample = async (grid, isotropic = false) => {
  const node = Fn(() => data.element(0).assign(vec4(isotropic ? grid.sampleIsotropicGPU(position)
    : grid.sampleScatteringGPU(position, view, g), 1)))().compute(1);
  renderer.compute(node);
  const value = [...new Float32Array(await renderer.getArrayBufferAsync(output))];
  node.dispose(); return value;
};
const clearLights = () => scene.children.filter(object => object.isLight).forEach(light => scene.remove(light));

window.testLighting = async () => {
  const grid = new LightingGrid({ levels: 2, directions: 6, cellSize: 0.25, samplesPerInterval: 8, ambient: 'black' });
  const results = {};
  const ambientLight = new THREE.AmbientLight('#4488ff', 2);
  scene.add(ambientLight);
  const ambientOwner = {};
  grid.update(renderer, scene, bounds, { owner: ambientOwner, version: 0, extinctionGPU: () => uniform(4) });
  const ambientDense = await sample(grid);
  assert(close(ambientDense[2], 2), `scene AmbientLight remains visible inside a dense medium: ${JSON.stringify(ambientDense)}`);
  ambientLight.intensity = 0.5;
  grid.update(renderer, scene, bounds);
  assert(close((await sample(grid))[2], 0.5), 'ambient intensity updates without rebuilding the volume');
  grid.release(ambientOwner); scene.remove(ambientLight);
  results.ambientLight = ambientDense;
  const directional = new THREE.DirectionalLight('white', 1); directional.position.set(0, 0, 2); scene.add(directional);
  grid.update(renderer, scene, bounds); results.directional = await sample(grid);
  assert(close(results.directional[0], 1),
    `isotropic integration preserves injected directional energy: ${JSON.stringify(results.directional)}`);
  g.value = 0.65;
  const toward = await sample(grid);
  directional.position.z = -2;
  grid.update(renderer, scene, bounds); const away = await sample(grid); g.value = 0;
  assert(Math.abs(toward[0] - away[0]) > 0.05, 'HG scattering responds to directional rotation');
  results.directionalRotation = [toward, away];
  const unchanged = grid.statistics.updates;
  grid.update(renderer, scene, bounds);
  assert(grid.statistics.updates === unchanged, 'unchanged input does not dispatch lighting');

  clearLights();
  const point = new THREE.PointLight('red', 1, 5, 2); point.position.set(-0.8, 0, 0); scene.add(point);
  position.value.set(-0.5, 0, 0); grid.update(renderer, scene, bounds); const left = await sample(grid);
  position.value.set(0.5, 0, 0); const right = await sample(grid);
  assert(left[0] > right[0] * 1.3, 'point light has spatial falloff');
  point.position.x = 0.8; grid.update(renderer, scene, bounds); const moved = await sample(grid);
  assert(moved[0] > right[0] * 1.3, 'moving point lights updates radiance');
  const irrelevant = new THREE.PointLight('white', 100, 1); irrelevant.position.x = 100; scene.add(irrelevant);
  grid.update(renderer, scene, bounds); assert(grid.statistics.lights === 1, 'irrelevant finite lights are filtered');
  irrelevant.position.set(0, 0, 0);
  grid.update(renderer, scene, bounds);
  assert(grid.statistics.lights === 2, 'existing lights entering range are collected without reattachment');
  scene.remove(irrelevant);
  grid.update(renderer, scene, bounds);
  assert(grid.statistics.lights === 1, 'removed lights are released immediately');
  const resolved = await sample(grid, true);
  assert(resolved.every((value, i) => close(value, moved[i], 0.01)),
    'one-fetch isotropic lighting agrees with the complete directional integral');
  results.point = [left, right, moved];

  clearLights();
  const spot = new THREE.SpotLight('green', 4, 10, 0.25, 0.3, 2);
  spot.position.set(0, 0, 2); spot.target.position.set(0, 0, 0); scene.add(spot, spot.target);
  position.value.set(0, 0, 0); grid.update(renderer, scene, bounds); const cone = await sample(grid);
  position.value.set(0.9, 0, 0); const outside = await sample(grid);
  assert(cone[1] > outside[1] * 2, 'spot cone attenuates off-axis probes');
  results.spot = [cone, outside]; clearLights();

  const sh = new THREE.SphericalHarmonics3(); sh.coefficients[0].set(1 / 0.282095, 0, 0);
  const probe = new THREE.LightProbe(sh, 1); scene.add(probe);
  position.value.set(0, 0, 0); grid.update(renderer, scene, bounds); const probeRed = await sample(grid);
  probe.sh.coefficients[0].set(0, 0, 2 / 0.282095);
  grid.update(renderer, scene, bounds); const probeBlue = await sample(grid);
  assert(probeRed[0] > 0.9 && probeBlue[2] > 1.8, 'SH updates feed far-field radiance');
  results.probe = [probeRed, probeBlue];
  scene.add(directional); grid.includeSceneLights = false;
  grid.update(renderer, scene, bounds); const bakedOnly = await sample(grid);
  grid.includeSceneLights = true; grid.update(renderer, scene, bounds); const combined = await sample(grid);
  assert(close(bakedOnly[2], probeBlue[2]) && combined[0] > 0.8 && combined[2] > bakedOnly[2],
    'baked-only policy excludes direct injection without suppressing SH');
  clearLights();

  const pixels = new Float32Array(4 * 2 * 4).fill(0);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i + 1] = 1; pixels[i + 3] = 1; }
  const environment = new THREE.DataTexture(pixels, 4, 2, THREE.RGBAFormat, THREE.FloatType);
  environment.mapping = THREE.EquirectangularReflectionMapping; environment.needsUpdate = true;
  scene.environment = environment; grid.update(renderer, scene, bounds); const ambient = await sample(grid);
  assert(ambient[1] > 0.9 && ambient[0] < 0.01, 'environment direction samples enter the same cascades');
  results.environment = ambient;
  // A bright source narrower than a Fibonacci bin must still contribute to ambient radiance.
  const narrowPixels = new Float32Array(128 * 64 * 4);
  narrowPixels.set([10000, 0, 0, 1], 4 * (29 + 128 * 31));
  const narrow = new THREE.DataTexture(narrowPixels, 128, 64, THREE.RGBAFormat, THREE.FloatType);
  narrow.mapping = THREE.EquirectangularReflectionMapping; narrow.needsUpdate = true;
  scene.environment = narrow; grid.update(renderer, scene, bounds);
  const narrowSample = await sample(grid);
  assert(narrowSample[0] > 1, 'GPU SH projection retains a sub-bin HDR light source');
  results.narrowHDR = narrowSample;
  const faces = Array.from({ length: 6 }, () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
    const context = canvas.getContext('2d'); context.fillStyle = '#0000ff'; context.fillRect(0, 0, 2, 2);
    return canvas;
  });
  const cube = new THREE.CubeTexture(faces); cube.needsUpdate = true;
  scene.environment = cube; grid.update(renderer, scene, bounds); const cubeBlue = await sample(grid);
  assert(cubeBlue[2] > 0.9 && cubeBlue[0] < 0.01, 'raw cube environments are sampled directionally');
  results.cubemap = cubeBlue; scene.environment = null;

  const baked = new LightProbeGrid(2, 2, 2, 2, 2, 2);
  const atlas = new Float32Array(2 * 2 * 28 * 4);
  for (let z = 0; z < 4; z++) for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    atlas[4 * (x + 2 * (y + 2 * z)) + (x ? 2 : 0)] = 1 / 0.282095;
  }
  baked.texture = new THREE.Data3DTexture(atlas, 2, 2, 28);
  baked.texture.format = THREE.RGBAFormat; baked.texture.type = THREE.FloatType;
  baked.texture.minFilter = baked.texture.magFilter = THREE.LinearFilter; baked.texture.needsUpdate = true;
  scene.add(baked); position.value.set(-0.8, 0, 0); grid.update(renderer, scene, bounds);
  const bakedLeft = await sample(grid); position.value.x = 0.8; const bakedRight = await sample(grid);
  assert(bakedLeft[0] > bakedLeft[2] * 3 && bakedRight[2] > bakedRight[0] * 3,
    'Three LightProbeGrid atlas retains spatially distinct SH regions');
  results.probeGrid = [bakedLeft, bakedRight]; clearLights();

  scene.add(directional); directional.position.set(0, 0, 2); position.value.set(0, 0, 0);
  const owner = {}, sigma = uniform(2);
  const extinctionGPU = () => sigma;
  grid.update(renderer, scene, bounds, { owner, version: 0, extinctionGPU });
  const dense = await sample(grid); sigma.value = 0;
  grid.update(renderer, scene, bounds, { owner, version: 1, extinctionGPU }); const vacuum = await sample(grid);
  assert(dense[0] < vacuum[0] * 0.5, 'volume density attenuates directional transport');
  results.attenuation = [dense, vacuum];
  grid.release(owner); grid.scatteringIterations = 1; sigma.value = 0.4;
  grid.update(renderer, scene, bounds, { owner, version: 2, extinctionGPU });
  results.scattering = await sample(grid);
  assert(results.scattering.every(Number.isFinite), 'approximate scattering stays finite');

  // Renderers construct independent managed instances from configuration, even with a shared options object.
  const lightingGridOptions = { levels: 2, directions: 6, cellSize: 0.25, ambient: 'black' };
  volume.lightingGridOptions = lightingGridOptions;
  volume.update([], system, 0); await renderer.renderAsync(scene, camera);
  const managed = volume.lightingGrid;
  const second = new VolumeRenderer({ lightingGridOptions, field: source.field, steps: 16, dynamicResolution: false });
  system.addRenderer(second); system.updateRenderers(false); await renderer.renderAsync(scene, camera);
  assert(second.lightingGrid !== managed, 'configuration objects never share GPU ownership');
  second.destroy(); volume.update([], system, 0); await renderer.renderAsync(scene, camera);
  assert(managed.statistics.updates > 0, 'destroying another renderer leaves the first managed grid active');
  system.position.x = 2; system.updateMatrixWorld(true); volume.update([], system, 0);
  await renderer.renderAsync(scene, camera);
  assert(managed.bounds.min.x > 0.9, 'lighting bounds follow the rendered volume into world space');
  system.scale.x = 2; system.updateMatrixWorld(true); volume.update([], system, 0);
  await renderer.renderAsync(scene, camera);
  assert(managed.bounds.getSize(new THREE.Vector3()).x > 3.9, 'rectangular domains can resize their probe storage');
  const beforeQuality = managed.version;
  lightingGridOptions.directions = [4, 8, 16]; lightingGridOptions.levels = 3;
  volume.update([], system, 0); await renderer.renderAsync(scene, camera);
  assert(managed.version > beforeQuality, 'structural edits rebuild lighting sampling without changing volume fields');
  volume.downsample = 2; volume.update([], system, 0); await renderer.renderAsync(scene, camera);
  volume.downsample = 1; system.scale.x = 1;
  system.position.x = 0; system.updateMatrixWorld(true);
  clearLights();
  const colorScene = createColorLights(scene);
  colorScene.update(0);
  await renderer.renderAsync(scene, camera);
  assert(managed.statistics.lights === 4, 'switching to Color Lights lights the existing volume');
  const colorUpdates = managed.statistics.updates;
  colorScene.update(0.5);
  await renderer.renderAsync(scene, camera);
  assert(managed.statistics.updates > colorUpdates, 'animated scene lights refresh a paused volume');
  colorScene.cleanup();

  const cleanupStudio = createStudio(scene);
  const loading = performance.now();
  while (!scene.environment) {
    if (performance.now() - loading > 5000) throw new Error('Studio HDRI load timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await renderer.renderAsync(scene, camera);
  assert(managed.farFieldKey.startsWith('equirect:'), 'switching to HDRI replaces the far-field source');
  results.sceneSwitches = { colorLights: 4, environment: await sample(managed) };
  assert(results.sceneSwitches.environment.slice(0, 3).every(value => value > 0.2),
    'actual studio HDRI supplies radiance above its weak ambient light alone');
  cleanupStudio();
  volume.lightingGridOptions = undefined; volume.update([], system, 0);
  await renderer.renderAsync(scene, camera);
  grid.dispose(); grid.dispose(); environment.dispose(); narrow.dispose(); cube.dispose(); baked.texture.dispose();
  return results;
};

window.measureLighting = async ({ levels, directions, count, cellSize = 0.25 }) => {
  clearLights();
  for (let i = 0; i < count; i++) {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const light = new THREE.PointLight(new THREE.Color().setHSL(i / count, 0.7, 0.5), 4 / count, 8, 2);
    light.position.set(Math.cos(angle) * 1.5, Math.sin(angle) * 1.5, 1);
    scene.add(light);
  }
  volume.lightingGridOptions = { levels, directions, cellSize, ambient: '#111111' };
  volume.update([], system, 0);
  const grid = volume.lightingGrid;
  for (let i = 0; i < 3; i++) { grid.needsUpdate = true; await renderer.renderAsync(scene, camera); }
  await fence();
  const samples = [];
  if (renderer.backend.device.features.has('timestamp-query')) {
    const timer = passTimer(renderer.backend.device, renderer.backend, () => 'lighting');
    try {
      for (let i = 0; i < 5; i++) {
        grid.needsUpdate = true; timer.start();
        await renderer.renderAsync(scene, camera); samples.push(await timer.finish());
      }
    } finally { timer.dispose(); }
  }
  const result = { levels, directions, count, cellSize, statistics: { ...grid.statistics },
    updateGPUms: samples.map(sample => sample.computeGPUms), raymarchGPUms: samples.map(sample => sample.renderGPUms) };
  window.lastLightingGrid = grid;
  return result;
};
window.ready = true;

window.lightingFixture = { renderer, scene, camera, system, volume, source, bounds, position, sample, clearLights, THREE, float };
