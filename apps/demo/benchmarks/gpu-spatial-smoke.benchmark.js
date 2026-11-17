import * as THREE from 'three';
import { vec3 } from 'three/tsl';
import {
  Boids,
  Collision,
  Module,
  ParticleForceField,
  SpriteRenderer,
  SpatialEffect,
  ThreeGPUCollisionBackend,
} from '@rzmps/rzmps';
import boidsPreset from 'examples/presets/boids.js';

export default {
  id: 'gpu-spatial-smoke',
  name: 'gpu-spatial-smoke workloads',
  feature: 'spatial/behavior',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  createCases(_context) {
    return [
      {
        name: 'GPU Boids behavioral smoke',
        particleCount: 48,
        requireGPU: true,
        minimumDurationMs: 750,
        create: () => ({
          gpuProcessing: true,
          modules: [
            new Boids({
              tags: 'flock',
              neighborRadius: 4,
              alignmentWeight: 0,
              cohesionWeight: 3,
              separationWeight: 0,
              steering: 12,
              spatialGridOptions: {
                bounds: new THREE.Box3(new THREE.Vector3(-4, -4, -4), new THREE.Vector3(4, 4, 4)),
                brickSubdivisions: 2,
                cellSubdivisions: 2,
                autoExpand: false,
              },
            }),
          ],
        }),
        configure: system => {
          system.particles.forEach((particle, index) => {
            const angle = (index / system.particles.length) * Math.PI * 2;
            const direction = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
            particle.position.copy(direction).multiplyScalar(2);
            particle.orbitCenter.copy(particle.position);
            particle.velocity.copy(direction);
            // Integration applies particle.speed separately; Boids should preserve
            // velocity magnitude rather than multiplying by this value twice.
            particle.speed = 4;
            particle.tags = ['flock'];
            particle.data.initialDirection = direction;
            particle.cache();
          });
        },
        beforeUpdate: (system, elapsed) => {
          if (elapsed < 250 || system.__gridDiagnosticsPromise) return;
          const grid = system.modules[0].getParticleSpatialGrid(system);
          system.__gridDiagnosticsPromise = grid
            .readDiagnostics(system.sceneRenderer)
            .then(diagnostics => {
              system.__gridDiagnostics = diagnostics;
            })
            .catch(() => {
              system.__gridDiagnosticsPromise = undefined;
            });
        },
        validate: system => {
          const unchanged = system.particles.filter(
            particle => particle.velocity.clone().normalize().dot(particle.data.initialDirection) > 0.9,
          );
          if (unchanged.length > system.particles.length * 0.75) {
            throw new Error(
              `GPU Boids left ${unchanged.length}/${system.particles.length} particles moving outward; ` +
                `samples ${JSON.stringify(
                  system.particles.slice(0, 3).map(particle => ({
                    position: particle.position.toArray(),
                    velocity: particle.velocity.toArray(),
                    initial: particle.data.initialDirection.toArray(),
                    alive: particle.alive,
                  })),
                )}; ` +
                `grid diagnostics ${JSON.stringify(system.__gridDiagnostics)}.`,
            );
          }
          const accelerated = system.particles.filter(particle => Math.abs(particle.velocity.length() - 1) > 0.05);
          if (accelerated.length > 0) {
            throw new Error(
              'GPU Boids changed base velocity magnitude for ' +
                `${accelerated.length}` +
                '/' +
                `${system.particles.length}` +
                ' particles.',
            );
          }
        },
      },
      {
        name: 'GPU BoidAffector geometry smoke',
        particleCount: 24,
        requireGPU: true,
        minimumDurationMs: 1000,
        create: () => {
          const target = Boids.BoidAffector.Sphere(
            {
              weight: Boids.BoidAffector.Weight.Target * 2,
              distance: 0.25,
              range: 6,
              tags: 'flock',
            },
            0.5,
            12,
            8,
          );
          return {
            gpuProcessing: true,
            modules: [
              new Boids({
                tags: 'flock',
                alignmentWeight: 0,
                cohesionWeight: 0,
                separationWeight: 0,
                affectorWeight: 1,
                steering: 8,
                neighborRadius: 4,
                affectors: [target],
              }),
            ],
          };
        },
        configure: system => {
          system.particles.forEach((particle, index) => {
            const angle = (index / system.particles.length) * Math.PI * 2;
            const direction = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0);
            particle.position.copy(direction).multiplyScalar(2);
            particle.orbitCenter.copy(particle.position);
            particle.velocity.copy(direction);
            particle.speed = 1;
            particle.tags = ['flock'];
            particle.data.initialDirection = direction;
            particle.cache();
          });
        },
        beforeUpdate: (system, elapsed) => {
          if (elapsed < 100 || system.__boidAffectorReadbackPromise) return;
          system.__boidAffectorReadbackPromise = system.selectiveReadback().then(results => {
            system.__boidAffectorReadback = results;
          });
        },
        validate: system => {
          const samples = system.__boidAffectorReadback;
          if (!samples) throw new Error('GPU BoidAffector verification readback did not complete.');
          const unchanged = samples.filter(
            result =>
              result.particle.velocity.clone().normalize().dot(system.particles[result.slot].data.initialDirection) >
              0.999,
          );
          if (unchanged.length > samples.length * 0.25) {
            throw new Error(
              `GPU BoidAffector left ${unchanged.length}/${samples.length} particles moving outward; ` +
                `samples ${JSON.stringify(samples.slice(0, 3).map(result => result.particle.velocity.toArray()))}.`,
            );
          }
        },
      },
      {
        name: 'GPU moving spatial effect smoke',
        particleCount: 24,
        requireGPU: true,
        minimumDurationMs: 3000,
        create: () => ({
          gpuProcessing: true,
          modules: [],
          spatialEffects: [
            ParticleForceField.Sphere(
              {
                position: new THREE.Vector3(6, 0, 0),
                direction: new THREE.Vector3(4, 0, 0),
              },
              2,
              12,
              8,
            ),
          ],
        }),
        configure: system => {
          system.particles.forEach(particle => {
            particle.position.set(0, 0, 0);
            particle.orbitCenter.copy(particle.position);
            particle.velocity.set(0, 0, 0);
            particle.speed = 1;
            particle.cache();
          });
        },
        beforeUpdate: (system, elapsed) => {
          if (
            !system.__movingSpatialBaseline &&
            system.gpuSimulation._gpuSpatialRegistry &&
            system.gpuSimulation._gpuSimulationComputeCache
          ) {
            system.__movingSpatialBaseline = system.gpuConfigurationStats.pipelineBuilds;
            system.spatialEffects[0].position.set(0, 0, 0);
            system.__movingSpatialMovedAt = elapsed;
          }
          if (
            elapsed >= (system.__movingSpatialMovedAt ?? Number.POSITIVE_INFINITY) + 250 &&
            system.__movingSpatialBaseline &&
            !system.__movingSpatialReadbackPromise
          ) {
            system.__movingSpatialReadbackPromise = system.selectiveReadback().then(results => {
              system.__movingSpatialReadback = results;
            });
          }
        },
        validate: system => {
          if (system.__movingSpatialBaseline === undefined) {
            throw new Error('Moving spatial effect did not establish a compiled baseline.');
          }
          if (system.gpuConfigurationStats.pipelineBuilds !== system.__movingSpatialBaseline) {
            throw new Error('Moving a spatial effect rebuilt the GPU simulation pipeline.');
          }
          if (system.gpuSpatialStats.bvhRefits === 0) {
            throw new Error('Moving a spatial effect did not refit its registry BVH bounds.');
          }
          const samples = system.__movingSpatialReadback;
          if (!samples) throw new Error('Moving force-field verification readback did not complete.');
          const influenced = samples.filter(result => result.particle.velocity.x > 0.1);
          if (influenced.length < samples.length * 0.75) {
            throw new Error(
              `Moved GPU force field influenced ${influenced.length}/${samples.length} particles; ` +
                `samples ${JSON.stringify(
                  samples.slice(0, 3).map(result => ({
                    position: result.particle.position.toArray(),
                    velocity: result.particle.velocity.toArray(),
                  })),
                )}; stats ${JSON.stringify(system.gpuSpatialStats)}.`,
            );
          }
        },
      },
      {
        name: 'GPU automatic color feather smoke',
        particleCount: 2,
        requireGPU: true,
        minimumDurationMs: 900,
        create: () => ({
          gpuProcessing: true,
          modules: [],
          spatialEffects: [
            SpatialEffect.Sphere(
              particle => {
                particle.color.set(0xff0000);
              },
              {
                feather: 2,
                featherEasing: strength => strength * strength,
                priority: Module.Priority.Permanent,
                modifyGPU: particle => {
                  particle.color.assign(vec3(1, 0, 0));
                },
              },
              1,
              12,
              8,
            ),
          ],
        }),
        configure: system => {
          system.particles[0].position.set(0, 0, 0);
          system.particles[1].position.set(2, 0, 0);
          system.particles.forEach(particle => {
            particle.orbitCenter.copy(particle.position);
            particle.velocity.set(0, 0, 0);
            particle.color.set(0xffffff);
            particle.cache();
          });
        },
        beforeUpdate: system => {
          if (!system.gpuSimulation._gpuBuffers || system.__automaticFeatherReadbackPromise) return;
          system.__automaticFeatherReadbackPromise = system.selectiveReadback(2).then(results => {
            system.__automaticFeatherReadback = results;
          });
        },
        validate: system => {
          const samples = system.__automaticFeatherReadback;
          if (!samples || samples.length !== 2) {
            throw new Error('Automatic color feather verification readback did not complete.');
          }
          const inside = samples[0].particle.color;
          const feathered = samples[1].particle.color;
          if (inside.g > 0.05 || inside.b > 0.05) {
            throw new Error(`Full-strength GPU color effect did not reach red: ${inside.toArray()}.`);
          }
          if (Math.abs(feathered.g - 0.75) > 0.08 || Math.abs(feathered.b - 0.75) > 0.08) {
            throw new Error(
              `GPU automatic color feather expected eased 25% red blend, received ${feathered.toArray()}.`,
            );
          }
        },
      },
      {
        name: 'GPU emitting boids coverage smoke',
        particleCount: 0,
        requireGPU: true,
        minimumDurationMs: 3200,
        createSystem: async () => {
          const system = await boidsPreset();
          system.gpuProcessing = true;
          return system;
        },
        configureScene: benchmarkScene => {
          const target = Boids.BoidAffector.Sphere(
            {
              position: new THREE.Vector3(10, 2, -8),
              weight: Boids.BoidAffector.Weight.Target * 2.5,
              distance: 1.75,
              tags: 'boid',
            },
            1.25,
            16,
            8,
          );
          const container = Boids.BoidAffector.Box(
            {
              position: new THREE.Vector3(0, 2, 0),
              weight: Boids.BoidAffector.Weight.Obstacle * 3.25,
              inverted: true,
              distance: 3.4,
              tags: 'boid',
            },
            52,
            26,
            46,
          );
          benchmarkScene.add(target, container);
          return [target, container];
        },
        beforeUpdate: (system, elapsed) => {
          if (elapsed < 2200 || !system.isGPUProcessingActive || system.__emittingBoidsReadbackPromise) return;
          system.__emittingBoidsReadbackPromise = system.selectiveReadback().then(results => {
            system.__emittingBoidsReadback = results;
          });
          const grid = system.modules.find(module => module instanceof Boids)?.getParticleSpatialGrid(system);
          system.__emittingBoidsGridPromise = grid?.readDiagnostics(system.sceneRenderer).then(diagnostics => {
            system.__emittingBoidsGrid = diagnostics;
          });
        },
        validate: system => {
          const samples = system.__emittingBoidsReadback?.filter(sample => sample.valid) ?? [];
          const hazards = samples.filter(sample => sample.particle.tags?.includes('hazard'));
          const diagnostics = system.__emittingBoidsGrid;
          if (samples.length < 50 || hazards.length < 2) {
            throw new Error(
              `Emitting boid readback covered ${samples.length} particles and ${hazards.length} predators; ` +
                `allocation ${JSON.stringify(system.gpuAllocationStats)}; ` +
                `raw ${JSON.stringify(
                  (system.__emittingBoidsReadback ?? []).slice(0, 8).map(sample => ({
                    valid: sample.valid,
                    slot: sample.slot,
                    tags: sample.particle.tags,
                    position: sample.particle.position.toArray(),
                    velocity: sample.particle.velocity.toArray(),
                    lifetime: sample.particle.lifetime,
                    realtime: sample.particle.realtime,
                  })),
                )}.`,
            );
          }
          if (!diagnostics || diagnostics.referencedSlots < samples.length) {
            throw new Error(
              `Boid grid omitted live slots: ${JSON.stringify(diagnostics)} for ${samples.length} samples.`,
            );
          }
          const escaped = samples.filter(
            ({ particle }) =>
              !particle.tags?.includes('hazard') &&
              (Math.abs(particle.position.x) > 28 ||
                particle.position.y < -15 ||
                particle.position.y > 15 ||
                Math.abs(particle.position.z) > 25),
          );
          if (escaped.length > 0) {
            throw new Error(`Boid container lost ${escaped.length}/${samples.length} sampled particles.`);
          }
          const hazardDirections = hazards.map(({ particle }) => particle.velocity.clone().normalize());
          const firstDirection = hazardDirections[0];
          const unsteered = hazardDirections.filter(direction => direction.dot(firstDirection) > 0.999);
          if (unsteered.length === hazardDirections.length) {
            throw new Error('All sampled predators retained the same unsteered direction.');
          }
        },
      },
      {
        name: 'GPU BoidAffector coordinate-space smoke',
        particleCount: 1,
        requireGPU: true,
        minimumDurationMs: 700,
        create: () => ({
          gpuProcessing: true,
          modules: [
            new Boids({
              tags: 'probe',
              alignmentWeight: 0,
              cohesionWeight: 0,
              separationWeight: 0,
              affectorWeight: 1,
              steering: 20,
              maintainSpeed: false,
              neighborRadius: 1,
              spatialGridOptions: {
                bounds: new THREE.Box3(new THREE.Vector3(-16, -16, -16), new THREE.Vector3(16, 16, 16)),
                brickSubdivisions: 1,
                cellSubdivisions: 2,
                autoExpand: false,
              },
            }),
          ],
        }),
        configure: system => {
          system.position.set(0, 7, 0);
          const particle = system.particles[0];
          particle.position.set(0, 0, 0);
          particle.orbitCenter.set(0, 0, 0);
          particle.velocity.set(0, 0, 0);
          particle.tags = ['probe'];
          particle.cache();
        },
        configureScene: benchmarkScene => {
          const target = Boids.BoidAffector.Sphere(
            {
              position: new THREE.Vector3(8, 7, 0),
              weight: Boids.BoidAffector.Weight.Target,
              range: 100,
              tags: 'probe',
            },
            1,
            12,
            8,
          );
          benchmarkScene.add(target);
          return [target];
        },
        beforeUpdate: (system, elapsed) => {
          if (elapsed < 250 || system.__boidCoordinateReadbackPromise) return;
          system.__boidCoordinateReadbackPromise = system.selectiveReadback(1).then(results => {
            system.__boidCoordinateReadback = results;
          });
        },
        validate: system => {
          const velocity = system.__boidCoordinateReadback?.[0]?.particle.velocity;
          if (!velocity) throw new Error('BoidAffector coordinate readback did not complete.');
          if (velocity.x <= 0 || Math.abs(velocity.y) > Math.abs(velocity.x) * 0.02) {
            throw new Error(`Translated GPU boid targeted outside the affector transform: ${velocity.toArray()}.`);
          }
        },
      },
      {
        name: 'GPU Collision behavioral smoke',
        particleCount: 48,
        requireGPU: true,
        minimumDurationMs: 900,
        create: () => {
          return {
            gpuProcessing: true,
            renderer: new SpriteRenderer(),
            modules: [
              new Collision({
                bounce: 1,
                dampen: 0,
              }),
            ],
          };
        },
        configureScene: benchmarkScene => {
          const floor = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 8));
          floor.position.y = -0.5;
          benchmarkScene.add(floor);
          return [floor];
        },
        configure: system => {
          system.__rzmpsBenchmarkCollisionEvents = 0;
          system.onCollision((particle, collision) => {
            system.__rzmpsBenchmarkCollisionEvents += 1;
            system.__rzmpsBenchmarkLastCollision = {
              position: particle.position.toArray(),
              velocity: particle.velocity.toArray(),
              point: collision.point.toArray(),
              normal: collision.normal.toArray(),
              impulse: collision.impulse.toArray(),
            };
          });
          system.particles.forEach((particle, index) => {
            particle.position.set(
              (index % 8) * 0.35 - 1.225,
              0.3 + Math.floor(index / 8) * 0.01,
              Math.floor(index / 8) * 0.35 - 0.875,
            );
            particle.orbitCenter.copy(particle.position);
            particle.velocity.set(0, -1, 0);
            particle.speed = 1;
            particle.cache();
          });
        },
        beforeUpdate: (system, elapsed) => {
          if (elapsed < 650 || system.__rzmpsCollisionReadbackPromise) return;
          system.__rzmpsCollisionReadbackPromise = system.selectiveReadback().then(results => {
            system.__rzmpsCollisionReadback = results;
          });
        },
        validate: system => {
          if (!(system.modules[0].backend instanceof ThreeGPUCollisionBackend)) {
            throw new Error('Collision did not select ThreeGPUCollisionBackend automatically.');
          }
          const readback = system.__rzmpsCollisionReadback;
          if (!readback) {
            throw new Error('GPU Collision selective verification readback did not complete.');
          }
          const valid = readback.filter(result => result.valid);
          const bounced = valid.filter(result => result.particle.velocity.y > 0.1);
          if (bounced.length < valid.length * 0.75) {
            throw new Error(
              `GPU Collision bounced ${bounced.length}/${valid.length} particles in direct GPU readback; ` +
                `events ${system.__rzmpsBenchmarkCollisionEvents}; samples ${JSON.stringify(
                  valid.slice(0, 3).map(result => ({
                    position: result.particle.position.toArray(),
                    velocity: result.particle.velocity.toArray(),
                    alive: result.particle.alive,
                  })),
                )}; last event ${JSON.stringify(system.__rzmpsBenchmarkLastCollision)}.`,
            );
          }
          if (system.__rzmpsBenchmarkCollisionEvents <= 0) {
            throw new Error('GPU Collision did not deliver collision events.');
          }
        },
      },
    ];
  },
};
