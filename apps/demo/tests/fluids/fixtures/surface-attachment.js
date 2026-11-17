import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, storage, vec3, vec4, float, uint } from 'three/tsl';
import { SurfaceAttachment, SurfaceRenderer } from '@rzmps/rzmps';
import LiquidSurface from '../../../../../packages/rzmps/src/rendering/gpu/LiquidSurface.ts';

const renderer = new WebGPURenderer();
await renderer.init();
const read = async attribute => [...new Float32Array(await renderer.getArrayBufferAsync(attribute))];
const owner = { getSimulationToWorldMatrix: () => new THREE.Matrix4(), isGPUProcessingActive: true };

window.testMeshAttachment = async () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const attachment = new SurfaceAttachment({ surface: mesh, adhesion: 1000, tangentialDrag: 20, offset: 0.05 });
  attachment.prepareSurface(owner, 0.1, true);
  const output = new StorageBufferAttribute(new Float32Array(12), 4), result = storage(output, 'vec4', 3);
  const position = vec3(0.5, 1.2, 0).toVar(), velocity = vec3(1, -1, 0).toVar();
  const sampleNode = Fn(() => {
    const particle = { position, velocity, speed: float(1), alive: uint(1).toVar() };
    attachment.finalizeGPU(particle, float(0.1));
    result.element(0).assign(vec4(particle.position, particle.alive));
    result.element(1).assign(vec4(particle.velocity, 0));
    const sample = attachment.sampleSurfaceGPU(vec3(0.5, 1.2, 0));
    result.element(2).assign(vec4(sample.velocity, sample.valid));
  })().compute(1);
  try {
    renderer.compute(sampleNode); const stationary = await read(output);
    mesh.position.y = 0.25; attachment.prepareSurface(owner, 0.1, true);
    renderer.compute(sampleNode); const translating = await read(output);
    mesh.rotation.y = Math.PI / 6; attachment.prepareSurface(owner, 0.1, true);
    renderer.compute(sampleNode); const rotating = await read(output);
    return { stationary, translating, rotating, stats: { ...attachment.backend.stats } };
  } finally { sampleNode.dispose(); output.dispose(); attachment.cleanup(); mesh.geometry.dispose(); }
};

function surface() {
  return new LiquidSurface({ bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    voxelSize: 0.25, maxActiveBricks: 2, maxTriangles: 512, spatialGridOptions: {},
    particleRadius: 1.55, influenceRadius: 2.2, anisotropy: 0, anisotropyMinNeighbors: 6,
    anisotropyMaxStretch: 2, anisotropyNeighborhood: 2, fieldSmoothingIterations: 1,
    fieldSmoothing: 0.2, fieldClosing: 0.1, flowSmoothing: 0.75,
    velocityDetailRange: [0.5, 3], vorticityDetailRange: [1, 8],
  }, renderer);
}

function fillSurface(liquid, height, velocity = 2) {
  const grid = liquid.grid, field = storage(liquid.fieldAttribute, 'vec4', liquid.fieldAttribute.count);
  renderer.compute(Fn(() => { grid.pages.element(0).assign(1); grid.slots.element(0).assign(1); })().compute(1));
  grid.updateDispatch(renderer);
  renderer.compute(grid.compute(index => {
    const coordinate = grid.coordinate(index);
    const y = float(coordinate.y).mul(0.25).sub(1), scalar = float(0.2 + height).sub(y);
    field.element(index).assign(vec4(0, 0, 0, scalar));
    field.element(index.add(grid.cellCount)).assign(vec4(scalar.mul(velocity), 0, 0, 0));
  }));
  liquid.bindSurfaceQuery();
}

window.testLiquidAttachment = async () => {
  const liquid = surface(); fillSurface(liquid, 0.1);
  const output = new StorageBufferAttribute(new Float32Array(24), 4), result = storage(output, 'vec4', 6);
  const sample = liquid.sampleSurfaceGPU;
  const node = Fn(() => {
    const above = sample(vec3(0, 0.15, 0)), below = sample(vec3(0, 0.05, 0)), outside = sample(vec3(3, 0, 0));
    result.element(0).assign(vec4(above.normal, above.distance));
    result.element(1).assign(vec4(above.velocity, above.valid));
    result.element(2).assign(vec4(below.normal, below.distance));
    result.element(3).assign(vec4(outside.normal, outside.valid));
    const attachment = new SurfaceAttachment({ samplerGPU: sample, adhesion: 1000,
      offset: 0.01, tangentialDrag: 1, inheritSurfaceVelocity: 1, detachDistance: 0.3, killOnDetach: true });
    attachment.prepareSurface(owner, 0.1, true);
    const particle = { position: vec3(0, 0.15, 0).toVar(), velocity: vec3(1, 0, 0).toVar(),
      speed: float(1), alive: uint(1).toVar() };
    attachment.finalizeGPU(particle, float(0.1));
    result.element(4).assign(vec4(particle.position, particle.alive));
    result.element(5).assign(vec4(particle.velocity, 0));
  })().compute(1);
  try {
    renderer.compute(node); const initial = await read(output);
    fillSurface(liquid, 0.2);
    renderer.compute(node); const moved = await read(output);
    renderer.compute(Fn(() => liquid.grid.pages.element(0).assign(0))().compute(1));
    renderer.compute(node); const sparse = await read(output);
    const view = new SurfaceRenderer();
    const unprepared = Fn(() => result.element(0).assign(vec4(view.sampleSurfaceGPU(vec3(0)).velocity,
      view.sampleSurfaceGPU(vec3(0)).valid)))().compute(1);
    renderer.compute(unprepared); const missing = await read(output);
    unprepared.dispose(); view.destroy();
    return { initial, moved, sparse, missing };
  } finally { liquid.dispose(); node.dispose(); output.dispose(); }
};
Error.stackTraceLimit = 50;
window.ready = true;
