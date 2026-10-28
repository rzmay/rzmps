import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Fn, If, instanceIndex, uint, vec3 } from 'three/tsl';
import { Emitter, ParticleSystem, SurfaceRenderer, ColorOverLifetime, ScaleOverLifetime } from '@rzmps/rzmps';

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
  voxelSize: 0.0625, particleRadiusScale: 1, isoLevel: 0.2, maxActiveBricks: 128, maxTriangles: 20000,
  spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 0 },
  smoothingIterations: 0,
  material: new THREE.MeshStandardMaterial({ roughness: 0.24 }),
});
const system = new ParticleSystem({ gpuProcessing: true, maxParticles: 64, gravity: new THREE.Vector3(),
  emitters: [new Emitter({ tags: ['red', 'blue'], rate: 0, bursts: [{ time: 0, count: 64 }], initialValues: {
    lifetime: 100, scale: new THREE.Vector3(1, 1, 1), velocity: new THREE.Vector3(),
  } })], renderers: [surface],
});
scene.add(system);
await renderer.renderAsync(scene, camera);
system.advanceFrames(1, 1 / 60);

window.seedSurface = async samples => {
  const buffers = system._gpuBuffers;
  renderer.compute(Fn(() => {
    const p = buffers.storage.createParticle(undefined, true);
    p.alive.assign(0);
    samples.forEach((sample, index) => If(instanceIndex.equal(index), () => {
      p.alive.assign(1);
      p.position.assign(vec3(...sample.position));
      p.velocity.assign(vec3(0));
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
  })().compute(buffers.count));
  surface.updateGPU(buffers, system);
  await renderer.renderAsync(scene, camera);
  return window.readSurface();
};
window.readSurface = async () => {
  const helper = surface.surface;
  const read = async (attribute, Type = Float32Array) => new Type(await renderer.getArrayBufferAsync(attribute));
  const positions = await read(helper.positionAttribute);
  const normals = await read(helper.normalAttribute);
  const colors = await read(helper.colorAttribute);
  const draw = await read(helper.drawAttribute, Uint32Array);
  const indices = (await read(helper.indexAttribute, Uint32Array)).slice(0, draw[0]);
  const edges = new Map();
  const components = new Map();
  const root = i => { while (components.get(i) !== i) i = components.get(i); return i; };
  let invalid = 0, reversed = 0, red = 0, blue = 0, mixed = 0, volume = 0;
  for (const index of new Set(indices)) {
    components.set(index, index);
    const p = index * 4;
    if (!positions.slice(p, p + 4).every(Number.isFinite) || positions[p + 3] !== 1) invalid++;
    const length = Math.hypot(...normals.slice(p, p + 3));
    if (!Number.isFinite(length) || Math.abs(length - 1) > 1e-4) invalid++;
    if (!colors.slice(p, p + 4).every(Number.isFinite)) invalid++;
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
    normalVariation += new THREE.Vector3(...normals.slice(a * 4, a * 4 + 3))
      .distanceToSquared(new THREE.Vector3(...normals.slice(b * 4, b * 4 + 3)));
  }
  return { ...diagnostics, bounds: [diagnostics.bounds.min.toArray(), diagnostics.bounds.max.toArray()],
    volume: Math.abs(volume), normalVariation: normalVariation / Math.max(1, edges.size),
    invalid, reversed, red, blue, mixed, openEdges: [...edges.values()].filter(count => count !== 2).length,
    components: new Set([...components.keys()].map(root)).size, draw: [...draw],
    storageLimit: renderer.backend.device.limits.maxStorageBuffersPerShaderStage };
};
window.surfaceFixture = { renderer, scene, camera, surface, system, THREE, ColorOverLifetime, ScaleOverLifetime };
window.ready = true;
