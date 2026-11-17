import * as THREE from 'three';
import { Fn, If, instanceIndex, vec3, float } from 'three/tsl';
import {
  ParticleSystem, Emitter, EmissionShape, FLIPSimulation, FluidCollider, FluidBoundsPolicy,
  SurfaceRenderer, SurfaceExtraction, SurfaceAttachment, SpriteRenderer, Textures,
} from '@rzmps/rzmps';

/** Fixed fixtures avoid asset downloads, random emitter density and animated demo-scene changes. */
export function createLiquidWorkload({ count = 8000, kind = 'medium', translation = false,
  cellSubdivisions = kind === 'pressure' ? 4 : 3 } = {}) {
  const bounds = new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2));
  const flip = new FLIPSimulation({
    bounds, automaticPadding: false, boundsPolicy: FluidBoundsPolicy.Ballistic,
    spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions,
      autoExpand: false, autoVolumeQuality: false, volumeQuality: 4, maxBounds: 8 },
    pressureIterations: kind === 'pressure' ? 48 : 20,
    pressureDiagnostics: true, adaptiveTimestep: true, cfl: 2, maxFluidSubsteps: 8,
    externalForce: new THREE.Vector3(), maxVelocity: 8,
    picRatio: translation ? 0 : 0.05, particleSeparation: translation ? 0 : 0.15, particleSpacing: translation ? 0 : 1,
    collisionIterations: 2,
  });
  const surface = new SurfaceRenderer({
    bounds, voxelSize: kind === 'surface' ? 0.035 : 0.065,
    maxActiveBricks: kind === 'surface' ? 512 : 128,
    spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: 3 },
    extraction: SurfaceExtraction.SurfaceNets,
    fieldSmoothingIterations: 1, smoothingIterations: kind === 'surface' ? 3 : 1,
    material: new THREE.MeshStandardMaterial({ color: '#8dceeb', roughness: 0.25 }),
  });
  const system = new ParticleSystem({
    name: `Liquid benchmark ${kind}`, maxParticles: count, gpuProcessing: true, duration: 0, looping: false,
    gravity: new THREE.Vector3(0, translation ? 0 : -3, 0), gravityModifier: 1,
    emitters: [new Emitter({ source: EmissionShape.Box(1, 1, 1), rate: 0,
      bursts: [{ time: 0, count }], initialValues: {
        lifetime: 3600, mass: 1, speed: 1, scale: 0.045, color: new THREE.Color('#8dceeb'),
        velocity: new THREE.Vector3(translation ? 0.3 : 0, 0, 0),
      } })],
    modules: [flip], renderers: translation ? [] : [surface],
  });

  const colliders = [];
  const boxes = [];
  const box = (size, center) => {
    const collider = FluidCollider.Box(...size);
    collider.position.fromArray(center);
    colliders.push(collider);
    boxes.push({ center, halfSize: size.map(value => value / 2) });
  };
  if (!translation) {
    box([2.8, 0.2, 2.8], [0, -0.85, 0]);
    for (const axis of [0, 2]) for (const sign of [-1, 1]) {
      const size = [2.8, 2, 2.8], center = [0, 0.05, 0];
      size[axis] = 0.2; center[axis] = sign * 1.3;
      box(size, center);
    }
    if (kind === 'collider') for (let i = 0; i < 24; i++) {
      box([0.09, 0.7, 0.09], [(i % 6 - 2.5) * 0.35, -0.5, (Math.floor(i / 6) - 1.5) * 0.4]);
    }
  }

  // One ordinary case includes actual secondary selection/emission/render-output work.
  if (!translation && kind === 'surface') {
    const spray = new ParticleSystem({ maxParticles: 2000, duration: 0, looping: true,
      emitters: [new Emitter({ rate: 4, initialValues: { lifetime: 1, scale: 0.025, alpha: 0.1 } })],
      renderers: [new SpriteRenderer(Textures.Default)],
    });
    spray.name = 'Liquid Spray';
    system.addSubSystem(spray, { emitContinuous: true, ratio: 0.2, inheritVelocity: 1,
      shouldEmitGPU: FLIPSimulation.SprayCondition({ minimumSpeed: 0.5, maximumNeighbors: null }) });
  }
  if (!translation && kind === 'foam') {
    const foam = new ParticleSystem({ maxParticles: 2000, duration: 0, looping: true, gravityModifier: 0,
      emitters: [new Emitter({ rate: 12, initialValues: { lifetime: 2, scale: 0.06, alpha: 0.2 } })],
      modules: [new SurfaceAttachment({ surface, samplerGPU: surface.sampleSurfaceGPU,
        offset: 0.015, adhesion: 90, tangentialDrag: 2, detachDistance: 0.2, killOnDetach: true })],
      renderers: [new SpriteRenderer(Textures.Default, { softParticles: true, softParticleDistance: 0.08 })],
    });
    foam.name = 'Liquid Foam';
    const condition = FLIPSimulation.FoamCondition({ minimumSpeed: 0.2, maximumNeighbors: 24 });
    condition.spatialGridOptions = { ...flip.spatialGridOptions };
    system.addSubSystem(foam, { emitContinuous: true, ratio: 0.3, inheritVelocity: 1,
      inheritScale: 0, inheritLifetime: 0, inheritColor: 0, inheritAlpha: 0, shouldEmitGPU: condition });
  }
  system.__liquidFixture = { flip, surface: translation ? null : surface, count, colliders, boxes, translation };
  return system;
}

/** Reset only marker positions/velocities, after the normal GPU emission path creates their identities. */
export function seedLiquidLattice(system, renderer) {
  const { count, translation } = system.__liquidFixture;
  const buffers = system.gpuSimulation._gpuBuffers;
  if (!buffers || buffers.count < count) throw new Error(`Liquid fixture emitted ${buffers?.count ?? 0}/${count}`);
  const side = Math.ceil(Math.cbrt(count)), spacing = 1.1 / side;
  renderer.compute(Fn(() => {
    const particle = buffers.storage.createParticle(undefined, true);
    If(instanceIndex.lessThan(count), () => {
      particle.position.assign(vec3(instanceIndex.mod(side), float(instanceIndex).div(side).floor().mod(side),
        float(instanceIndex).div(side * side).floor()).add(0.5).mul(spacing).sub(0.55));
      particle.velocity.assign(vec3(translation ? 0.3 : 0, 0, 0));
      particle.scale.assign(vec3(spacing * 0.9));
      buffers.storage.storeParticle(particle);
    });
  })().compute(buffers.count));
  system.emitters[0].bursts = [];
  system.emitters[0].rate = 0;
}
