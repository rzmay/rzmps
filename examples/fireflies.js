import * as THREE from 'three';
import { If, float, uint, vec3, vec4 } from 'three/tsl';
import {
  Emitter,
  EmissionShape,
  LightRenderer,
  LimitVelocityOverLifetime,
  Module,
  ParticleSystem,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TransformByNoise,
} from '@rzmps/rzmps';
import fireflyImage from '../apps/demo/src/assets/images/firefly.png?url';

export default async function createFireflies() {
  // #region docs:system:1
  // Sparse neighbors allow local flash clusters without synchronizing the entire population.
  const radius = 2.25;
  const pulseDuration = 0.65;
  const cooldown = 1.4;
  const spawnBounds = new THREE.Box3(
    new THREE.Vector3(-12, -0.5, -8),
    new THREE.Vector3(12, 5.5, 8),
  );
  // Spawn inside the central box, but allow substantial travel before recycling a firefly.
  const killBounds = spawnBounds.clone().expandByVector(new THREE.Vector3(10, 4, 8));
  const size = spawnBounds.getSize(new THREE.Vector3());
  const source = EmissionShape.Box(size.x, size.y, size.z);
  source.position.copy(spawnBounds.getCenter(new THREE.Vector3()));

  // #region docs:modules:1
  // Mass is an application-owned charge accumulator here: negative values are the refractory period.
  const flashing = charge => charge < -(cooldown - pulseDuration);
  const flash = new Module(
    (particle, dt, system, octree) => {
      let neighbors = 0;

      // An insect must recharge before it can respond to another insect's flash.
      if (particle.mass >= 0.35) {
        for (const other of octree.particlesInRadius(particle.position, radius)) {
          if (other !== particle && flashing(other.mass)) neighbors++;
        }
      }

      const nearbyFlashes = Math.min(neighbors, 4);
      const strength = 0.75 + nearbyFlashes * 0.15;
      const chargeRate = particle.mass < 0 ? 1 : 0.18 + nearbyFlashes * 0.5;
      particle.mass += dt * chargeRate;

      // This threshold depends on neighbors, not just the particle's age or lifecycle.
      if (particle.mass >= 1) {
        particle.mass = -cooldown;
        particle.emitEvent('flash', { strength });
      }
    },
    {
      useOctree: true,
      octreeOptions: { bounds: killBounds },
      spatialGridOptions: {
        bounds: killBounds,
        brickSubdivisions: 1,
        cellSubdivisions: 3,
        autoExpand: false,
      },
      modifyGPU(particle, dt, context, grid) {
        // The paired TSL implementation runs entirely on GPU particle storage.
        const neighbors = float(0).toVar('flashingNeighbors');

        If(particle.mass.greaterThanEqual(0.35), () => {
          grid.forEachParticleInRadius(
            particle.position,
            float(radius),
            other => {
              If(other.mass.lessThan(-(cooldown - pulseDuration)), () => {
                neighbors.addAssign(1);
              });
            },
            { excludeIndex: particle.index },
          );
        });

        const nearbyFlashes = neighbors.min(4);
        const strength = nearbyFlashes.mul(0.15).add(0.75);
        const chargeRate = particle.mass.lessThan(0).select(float(1), nearbyFlashes.mul(0.5).add(0.18));
        particle.mass.addAssign(dt.mul(chargeRate));

        If(particle.mass.greaterThanEqual(1), () => {
          particle.mass.assign(-cooldown);
          // Payload convention: X is glow strength; the remaining components are unused.
          particle.emitEvent('flash', vec4(strength, 0, 0, 0));
        });
      },
    },
  );

  // Fireflies drift freely until they leave the volume; killing avoids both boundary crowding and grid growth.
  const cullOutside = new Module(
    particle => {
      if (!killBounds.containsPoint(particle.position)) particle.kill();
    },
    {
      modifyGPU(particle) {
        const below = particle.position.lessThan(vec3(killBounds.min)).any();
        const above = particle.position.greaterThan(vec3(killBounds.max)).any();
        If(below.or(above), () => {
          particle.kill();
        });
      },
    },
  );
  // #endregion docs:modules:1

  const fireflies = new ParticleSystem({
    duration: 120,
    gravityModifier: 0,
    maxParticles: 96,
    // #region docs:emitters:1
    emitters: new Emitter({
      source,
      rate: 8,
      bursts: { time: 0, count: 64 },
      initialValues: {
        lifetime: [24, 32],
        scale: 0.22,
        mass: [0, 1], // Stagger the initial charge so the insects start out of phase.
        color: '#b0b8a2',
      },
    }),
    // #endregion docs:emitters:1
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(1.5, 0.55, 1.5),
        frequency: 0.18,
        scrollSpeed: 0.18,
      }),
      cullOutside,
      new LimitVelocityOverLifetime({ limit: 1.3, drag: 0.55 }),
      flash,
    ],
    // #region docs:renderers:1
    renderers: new SpriteRenderer(fireflyImage, {
      materialOptions: { depthWrite: false },
    }),
    // #endregion docs:renderers:1
  });
  fireflies.name = 'Fireflies';

  // CPU references and GPU slot/generation pairs keep each glow on its living source during the pulse.
  const cpuSources = new Map();
  const cpuSourceSlots = new WeakMap();
  let nextSourceSlot = 0;
  // #region docs:modules:2
  class FollowGlow extends Module {
    constructor() {
      super(
        particle => {
          const parent = cpuSources.get(particle.mass);
          if (!parent?.alive) {
            particle.kill();
            return;
          }

          particle.position.copy(parent.position);
          particle.velocity.set(0, 0, 0);
          particle.alpha = 0.65 * Math.pow(Math.max(0, Math.sin(Math.PI * particle.time)), 1.5);
        },
        {
          modifyGPU(particle) {
            // Glow mass stores the source slot; distortionStrength stores its generation.
            // Checking both prevents a surviving glow from following a replacement insect in a reused slot.
            const parent = fireflies.gpuParticleBuffers.storage.createParticle(uint(particle.mass));
            const sourceAlive = parent.alive.notEqual(uint(0));
            const sameGeneration = parent.generation.equal(uint(particle.distortionStrength));

            If(sourceAlive.and(sameGeneration), () => {
              particle.position.assign(parent.position);
              particle.velocity.assign(vec3(0));
              // Keep opacity in simulation state so LightRenderer readback sees the same pulse envelope.
              particle.alpha.assign(particle.time.mul(Math.PI).sin().max(0).pow(1.5).mul(0.65));
            }).Else(() => {
              particle.kill();
            });
          },
        },
      );
    }

    // prepare runs once per step; preserve base preparation before pruning dead CPU references.
    prepare(system, dt) {
      super.prepare(system, dt);
      for (const [slot, parent] of cpuSources) {
        if (!parent.alive) cpuSources.delete(slot);
      }
    }
  }
  // #endregion docs:modules:2

  const glow = new ParticleSystem({
    duration: 0.1,
    gravityModifier: 0,
    maxParticles: 128,
    // #region docs:emitters:2
    emitters: new Emitter({
      source: EmissionShape.Box(0.01, 0.01, 0.01),
      bursts: { time: 0, count: 1 },
      initialValues: {
        lifetime: pulseDuration,
        scale: 0.38,
        color: '#d9ff65',
        alpha: 0,
        mass: 1, // Event context multiplies this value by the source's reference slot.
      },
    }),
    // #endregion docs:emitters:2
    // #region docs:modules:2
    modules: [
      new FollowGlow(),
      new ScaleOverLifetime({ scale: t => 0.7 + 0.3 * Math.sin(Math.PI * t) }),
    ],
    // #endregion docs:modules:2
    // #region docs:renderers:2
    renderers: [
      new SpriteRenderer(Textures.Simple, {
        materialOptions: {
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        },
      }),
      new LightRenderer({
        count: 32,
        ratio: 1,
        groupingRadiusRatio: 0,
        alphaAffectsIntensity: true,
        brightness: [0.2, 0.4],
        lightOptions: {
          distance: 25,
          intensity: 1,
          decay: 2,
        },
      }),
    ],
    // #endregion docs:renderers:2
  });
  glow.name = 'Firefly Pulses';
  fireflies.addSubSystem(glow, {
    inheritScale: 0,
    inheritColor: 0,
    inheritAlpha: 0,
    inheritLifetime: 0,
    onEvent: {
      // CPU payloads are unknown to the library; the application narrows its own schema.
      flash: (data, parent) => {
        if (typeof data !== 'object' || data === null || !('strength' in data)
          || typeof data.strength !== 'number') {
          return;
        }
        if (!cpuSourceSlots.has(parent)) {
          cpuSourceSlots.set(parent, nextSourceSlot++);
        }
        const slot = cpuSourceSlots.get(parent);
        cpuSources.set(slot, parent);
        return { scale: data.strength, mass: slot };
      },
      gpu: {
        // Resolve the native event snapshot into birth values; no CPU event readback is needed.
        flash: (data, parent) => ({
          scale: data[0].x,
          mass: float(parent.index),
          distortionStrength: float(parent.generation),
        }),
      },
    },
  });

  fireflies.addEventListener('destroyed', () => cpuSources.clear());
  // #endregion docs:system:1
  return fireflies;
}
createFireflies.author = 'rzmay';
export const metadata = {
  id: 'fireflies',
  title: 'Fireflies',
  description: 'Fireflies use spatial queries and native events to emit attached glow pulses and small lights.',
  tags: ['fireflies', 'gpu', 'events', 'spatial-grid', 'lights'],
  category: 'effects',
};
createFireflies.description = metadata.description;
