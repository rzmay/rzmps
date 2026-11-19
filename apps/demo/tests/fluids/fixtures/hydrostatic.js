import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, storage, vec3, vec4 } from 'three/tsl';
import { FLIPSimulation } from '@rzmps/rzmps';
const renderer = new WebGPURenderer();
await renderer.init();
const n = 16,
  h = 2 / n,
  dt = 1 / 120,
  gravity = 9.81;
const liquid = new FLIPSimulation({
  bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
  boundsPadding: 0,
  automaticPadding: false,
  adaptiveTimestep: false,
  spatialGridOptions: { maxBounds: 2, brickSubdivisions: 1, cellSubdivisions: 3 },
  pressureIterations: 512,
  pressureWarmStart: false,
  pressureDiagnostics: true,
  maxVelocity: 100,
});
liquid.initializeTransferFields();
const accessible = (x, y, z, open) =>
  x >= 0 &&
  y >= 0 &&
  z >= 0 &&
  x < n &&
  y < n &&
  z < n &&
  z >= 5 &&
  z <= 10 &&
  ((x >= 1 && x <= 8 && y >= 2 && y <= 14) ||
    (x >= 11 && x <= 13 && y >= 2 && y <= 14) ||
    (x >= 8 && x <= 11 && y >= 2 && y <= 3) ||
    (open && x >= 14 && y >= 6 && y <= 7));
// Explicitly populate the sparse projection domain; logical coordinates are not pool addresses.
const grid = liquid.workGrid;
renderer.compute(Fn(() => {
  grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
  grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
})().compute(8));
grid.updateDispatch(renderer);
const at = (x, y, z) => (Math.floor(x / 8) + 2 * (Math.floor(y / 8) + 2 * Math.floor(z / 8))) * 512
  + x % 8 + 8 * (y % 8 + 8 * (z % 8));
window.hydrostatic = async open => {
  // Isolate the matched FLIP projection from P2G/classification and particle collision.
  // Values are the exact intended pressure domain for a two-cell connecting passage.
  const input = new Float32Array(liquid.cellCount * 4),
    before = new Float32Array(input.length);
  const solid = new Float32Array(liquid.cellCount),
    boundary = new Float32Array(liquid.cellCount * 8);
  const fluidCells = [];
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = at(x, y, z),
          inside = accessible(x, y, z, open),
          wet = inside && y < 10;
        solid[i] = inside ? 0 : 1;
        if (wet) {
          input.set([0, -gravity * dt, 0, 2], i * 4);
          before.set([0, 0, 0, 1], i * 4);
          fluidCells.push([x, y, z]);
        }
        for (let axis = 0; axis < 3; axis++) {
          const lower = [x, y, z];
          lower[axis]--;
          boundary[i * 4 + axis] = inside && accessible(...lower, open) ? 1 : 0;
        }
        boundary[i * 4 + 3] = inside ? 1 : 0;
      }
  const upload = (attribute, values, offset = 0) => {
    attribute.array.fill(0);
    attribute.array.set(values, offset);
    attribute.needsUpdate = true;
  };
  upload(liquid.velocityNextAttribute, input);
  upload(liquid.velocityBeforeAttribute, before, liquid.cellCount * 4);
  upload(liquid.solidAttribute, solid);
  upload(liquid.boundaryAttribute, boundary);
  liquid.getPressureProjection().invalidate();
  liquid.solveProjection(renderer, liquid.velocityNext, liquid.velocityCurrent);
  const pressure = new Float32Array(await renderer.getArrayBufferAsync(liquid.pressureCurrentAttribute));
  const centerVelocity = new Float32Array(await renderer.getArrayBufferAsync(liquid.velocityCurrentAttribute));
  const samples = new StorageBufferAttribute(new Float32Array(liquid.cellCount * 4), 4);
  const target = storage(samples, 'vec4', liquid.cellCount);
  renderer.compute(
    liquid.computeCells(index =>
      target
        .element(index)
        .assign(vec4(liquid.getPressureProjection().sample(vec3(liquid.cellCoordinate(index)).add(0.5)), 0)),
    ),
  );
  const velocity = new Float32Array(await renderer.getArrayBufferAsync(samples));
  samples.dispose();
  const profile = [9, 8, 7, 6, 5, 4, 3, 2].map(y => ({
    y: -1 + (y + 0.5) * h,
    reservoir: pressure[at(4, y, 7)],
    riser: pressure[at(12, y, 7)],
  }));
  let maxSpeed = 0,
    squares = 0,
    flux = 0;
  for (const [x, y, z] of fluidCells) {
    const i = at(x, y, z),
      speed = Math.hypot(...velocity.slice(i * 4, i * 4 + 3));
    maxSpeed = Math.max(maxSpeed, speed);
    squares += speed ** 2;
    if (x === 14 && y >= 6 && y <= 7) flux += velocity[i * 4] * h * h;
  }
  const stats = await liquid.getPressureProjection().readDiagnostics(renderer, liquid.velocityCurrent);
  return {
    phase: open ? 'open-outlet' : 'sealed',
    n,
    h,
    dt,
    gravity,
    passageWidthCells: 2,
    headHeight: -1 + 10 * h,
    outletHeight: -1 + 8 * h,
    profile,
    normalizedGradient:
      (profile.at(-1).reservoir - profile[0].reservoir) / ((profile[0].y - profile.at(-1).y) * gravity * dt),
    centerFieldMaxSpeed: Math.max(
      ...fluidCells.map(([x, y, z]) => {
        const i = at(x, y, z);
        return Math.hypot(...centerVelocity.slice(i * 4, i * 4 + 3));
      }),
    ),
    maxSpeed,
    rmsSpeed: Math.sqrt(squares / fluidCells.length),
    gridOutletFlux: flux,
    stats,
    scope:
      'projection-only exact domain; P2G marker classification and evolving particle free surfaces are not asserted',
  };
};
window.ready = true;

// End-to-end marker test: normal P2G classification, MAC pressure, G2P, gravity and BVH collision.
window.communicatingMarkers = async () => {
  const { ParticleSystem, Emitter, FluidCollider } = await import('@rzmps/rzmps');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const colliders = [];
  const box = (minimum, maximum) => {
    const size = new THREE.Vector3(...maximum).sub(new THREE.Vector3(...minimum));
    const collider = FluidCollider.Box({ bakedFieldResolution: 8 }, size.x, size.y, size.z);
    collider.position.copy(new THREE.Vector3(...minimum).add(new THREE.Vector3(...maximum)).multiplyScalar(0.5));
    scene.add(collider); colliders.push(collider); return collider;
  };
  box([-1, -1, -1], [1, -0.75, 1]);
  box([-1, -0.75, -1], [-0.75, 1, 1]);
  box([-0.75, -0.75, -1], [1, 1, -0.375]);
  box([-0.75, -0.75, 0.375], [1, 1, 1]);
  box([0.125, -0.5, -0.375], [0.375, 1, 0.375]);
  const outlet = box([0.75, -0.75, -0.375], [1, 1, 0.375]);
  const positions = [];
  for (let z = -0.34375; z < 0.375; z += 0.0625) {
    for (let y = -0.71875; y < 0.25; y += 0.0625) {
      for (let x = -0.71875; x < 0.75; x += 0.0625) {
        if (x > 0.125 && x < 0.375 && y > -0.5) continue;
        positions.push(x, y, z, 1);
      }
    }
  }
  const count = positions.length / 4;
  const flip = new FLIPSimulation({ bounds: liquid.bounds.clone(), boundsPadding: 0, automaticPadding: false,
    adaptiveTimestep: false, pressureIterations: 128, pressureWarmStart: true, pressureDiagnostics: false,
    spatialGridOptions: { maxBounds: 2, brickSubdivisions: 1, cellSubdivisions: 3, autoExpand: false },
    spatialEffects: colliders, boundsPolicy: 'Contain', particleSeparation: 0.15,
  });
  const system = new ParticleSystem({ gpuProcessing: true, maxParticles: count, substep: false,
    gravity: new THREE.Vector3(0, -gravity, 0), gravityModifier: 1,
    emitters: new Emitter({ rate: 0, bursts: [{ time: 0, count }], initialValues: {
      lifetime: 100, speed: 1, mass: 1, scale: new THREE.Vector3(0.055, 0.055, 0.055),
      velocity: new THREE.Vector3(),
    } }), modules: flip, renderers: [],
  });
  scene.add(system); await renderer.renderAsync(scene, camera);
  system.advanceFrames(1, dt);
  const buffers = system.gpuSimulation._gpuBuffers;
  const initial = new StorageBufferAttribute(new Float32Array(positions), 4);
  const source = storage(initial, 'vec4', count);
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    particle.position.assign(source.element(instanceIndex).xyz); particle.velocity.assign(vec3(0));
    buffers.storage.storeParticle(particle);
  })().compute(count));
  const snapshot = async () => {
    const markers = (await system.selectiveReadback(count, ['position', 'velocity']))
      .filter(result => result.valid).map(result => result.particle);
    const reservoir = markers.filter(p => p.position.x < 0.1), riser = markers.filter(p => p.position.x > 0.4);
    const level = group => {
      const heights = group.map(p => p.position.y).sort((a, b) => a - b);
      return heights[Math.floor(heights.length * 0.95)] ?? -1;
    };
    return { count: markers.length, reservoirLevel: level(reservoir), riserLevel: level(riser),
      maxSpeed: Math.max(0, ...markers.map(p => p.velocity.length())),
      rmsSpeed: Math.sqrt(markers.reduce((s, p) => s + p.velocity.lengthSq(), 0) / Math.max(1, markers.length)),
      maximumX: Math.max(...markers.map(p => p.position.x)),
      apertureMarkers: markers.filter(p => p.position.x > 0.73 && Math.abs(p.position.y) < 0.16).length,
      outletMarkers: markers.filter(p => p.position.x > 0.8 && p.position.y < 0.25).length,
      rimMarkers: markers.filter(p => p.position.y > 0.8).length,
      belowFloor: markers.filter(p => p.position.y < -0.82).length };
  };
  const initialState = await snapshot();
  for (let i = 0; i < 96; i++) system.advanceFrames(1, dt);
  const sealed = await snapshot();
  const sealedPressure = await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent);
  scene.remove(outlet); colliders.splice(colliders.indexOf(outlet), 1);
  box([0.75, -0.75, -0.375], [1, -0.125, 0.375]);
  box([0.75, 0.125, -0.375], [1, 1, 0.375]);
  const fluxAttribute = new StorageBufferAttribute(12, 4);
  const fluxSamples = storage(fluxAttribute, 'vec4', 12);
  const fluxNode = Fn(() => {
    const coordinate = vec3(14, instanceIndex.mod(2).add(7.5), instanceIndex.div(2).add(5.5));
    fluxSamples.element(instanceIndex).assign(vec4(flip.getPressureProjection().sample(coordinate), 0));
  })().compute(12);
  let gridOutletFlux = 0, gridOutletVolume = 0;
  for (let chunk = 0; chunk < 12; chunk++) {
    for (let i = 0; i < 8; i++) system.advanceFrames(1, dt);
    renderer.compute(fluxNode);
    const samples = new Float32Array(await renderer.getArrayBufferAsync(fluxAttribute));
    let flux = 0;
    for (let i = 0; i < 12; i++) flux += samples[i * 4] * h * h;
    gridOutletFlux = Math.max(gridOutletFlux, flux);
    gridOutletVolume += Math.max(0, flux) * 8 * dt;
  }
  const open = await snapshot();
  const pressure = await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent);
  fluxNode.dispose(); fluxAttribute.dispose();
  system.destroy(); initial.dispose(); colliders.forEach(collider => collider.geometry.dispose());
  return { initial: initialState, sealed, open, sealedPressure, gridOutletFlux, gridOutletVolume,
    pressure, h, dt, elapsedPerPhase: 96 * dt };
};
