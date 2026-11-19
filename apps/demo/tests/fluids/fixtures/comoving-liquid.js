import * as THREE from 'three';
import { Fn, storage, vec3, vec4 } from 'three/tsl';
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import { FluidCollider, GeometryUpdatePolicy, SurfaceRenderer } from '@rzmps/rzmps';
import { createLiquidWorkload, seedLiquidLattice } from '../../../benchmarks/fluids/liquidWorkload.utils.js';
import { readLiquidMarkers, markerMetrics } from '../../../benchmarks/fluids/liquidQuality.utils.js';

const renderer = new WebGPURenderer();
renderer.setSize(320, 240);
document.body.append(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 100);
camera.position.set(2, 2, 3); camera.lookAt(0, 0, 0);

window.runComovingLiquid = async (mode = 'translation', frames = 64) => {
  const system = createLiquidWorkload({ count: 1000, translation: true, cellSubdivisions: 3 });
  const { flip } = system.__liquidFixture;
  flip.adaptiveTimestep = false;
  const vessel = new THREE.Group(), walls = [];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const size = [1.3, 1.3, 1.3]; size[axis] = 0.1;
    const wall = FluidCollider.Box({ updatePolicy: GeometryUpdatePolicy.TransformDynamic }, ...size);
    wall.position.setComponent(axis, sign * 0.6);
    vessel.add(wall); walls.push(wall);
  }
  // A plain material makes geometry observable without activity normals or flow shading.
  const surface = new SurfaceRenderer({
    voxelSize: 0.065, maxActiveBricks: 128,
    material: new THREE.MeshBasicMaterial({ color: 'white' }),
  });
  system.addRenderer(surface);
  scene.add(system);
  if (mode !== 'rotation-free') scene.add(vessel);
  system._renderer = renderer; system._scene = scene; system._camera = camera;
  const dt = 1 / 120, speed = mode === 'translation' ? 0.3 : 0;
  const omega = mode.startsWith('rotation') ? 0.4 : 0;
  const acceleration = mode === 'acceleration' ? 0.2 : 0;
  flip.externalForce.x = acceleration;
  const advance = async () => {
    system.advanceFrames(1, dt);
    await renderer.renderAsync(scene, camera);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  };
  try {
    await system.prepare(renderer);
    await advance(); seedLiquidLattice(system, renderer);
    const buffers = system.gpuSimulation._gpuBuffers;
    renderer.compute(Fn(() => {
      const particle = buffers.storage.createParticle(undefined, true);
      particle.velocity.assign(vec3(particle.position.z.mul(omega), 0, particle.position.x.mul(-omega))
        .add(vec3(speed, 0, 0)));
      buffers.storage.storeParticle(particle);
    })().compute(buffers.count));
    const initial = await readLiquidMarkers(system, renderer), original = new Map(initial.map(p => [p.id, p]));
    const backend = flip.particleCollisionBackend, before = { ...backend.stats };
    for (let frame = 1; frame <= frames; frame++) {
      const time = frame * dt;
      vessel.position.x = speed * time + 0.5 * acceleration * time ** 2;
      vessel.rotation.y = omega * time;
      vessel.updateWorldMatrix(true, true);
      await advance();
    }
    const markers = await readLiquidMarkers(system, renderer), metrics = markerMetrics(markers);
    const inverse = vessel.matrixWorld.clone().invert(), point = new THREE.Vector3(), velocity = new THREE.Vector3();
    let displacementSq = 0, velocitySq = 0, contacts = 0, contactErrorSq = 0, penetration = 0;
    const angle = omega * frames * dt, rotation = new THREE.Matrix4().makeRotationY(angle);
    for (const particle of markers) {
      const start = original.get(particle.id);
      const local = point.fromArray(particle.position).applyMatrix4(inverse).clone();
      const error = local.distanceToSquared(new THREE.Vector3(...start.position));
      displacementSq += error;
      const expected = velocity.fromArray(start.position).applyMatrix4(rotation);
      expected.set(omega * expected.z + speed + acceleration * frames * dt, 0, -omega * expected.x);
      velocitySq += expected.distanceToSquared(new THREE.Vector3(...particle.velocity));
      const edge = Math.max(...start.position.map(Math.abs));
      if (edge > 0.48) { contacts++; contactErrorSq += error; }
      penetration = Math.max(penetration,
        ...local.toArray().map(value => Math.abs(value) + particle.radius / 2 - 0.55));
    }
    const projection = flip.getPressureProjection();
    const wallAttribute = new StorageBufferAttribute(new Float32Array(flip.cellCount * 4).fill(1e20), 4);
    const output = storage(wallAttribute, 'vec4', flip.cellCount);
    renderer.compute(flip.computeCells(index => {
      const coordinate = flip.cellCoordinate(index);
      const closed = projection.open(coordinate, 0).lessThanEqual(0);
      output.element(index).assign(vec4(closed.select(projection.wall(coordinate, 0), 1e20), 0, 0, 0));
    }));
    const data = new Float32Array(await renderer.getArrayBufferAsync(wallAttribute));
    const velocities = data.filter((value, index) => index % 4 === 0 && value < 1e10);
    const expectedWallSpeed = speed + acceleration * (frames - 0.5) * dt;
    const wall = { closedXFaces: velocities.length,
      wrongXFaces: omega ? null : velocities.filter(value => Math.abs(value - expectedWallSpeed) > 1e-4).length };
    renderer.backend.destroyAttribute(wallAttribute); wallAttribute.dispose();
    return { mode, frames, dt, wall, expectedTime: frames * dt, initial: markerMetrics(initial), final: metrics,
      rmsComovingDisplacement: Math.sqrt(displacementSq / markers.length),
      rmsVelocityError: Math.sqrt(velocitySq / markers.length), contacts,
      rmsContactDisplacement: Math.sqrt(contactErrorSq / Math.max(1, contacts)), maxPenetration: penetration,
      pressure: await flip.getPressureProjection().readDiagnostics(renderer, flip.velocityCurrent),
      surface: await surface.readSurfaceDiagnostics(), before, after: { ...backend.stats } };
  } finally {
    await renderer.backend.device.queue.onSubmittedWorkDone();
    system.destroy(); system.removeFromParent(); vessel.removeFromParent();
    walls.forEach(wall => wall.geometry.dispose());
  }
};
window.ready = true;
