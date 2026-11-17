import * as THREE from 'three';
import { Collision, ParticleForceField, ThreeGPUCollisionBackend } from '@rzmps/rzmps';
import { NoopRenderer } from './benchmark.utils.js';

export default {
  id: 'dynamic-spatial',
  name: 'dynamic-spatial workloads',
  feature: 'spatial/dynamic',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  readbackRate: 0,
  createCases(_context) {
    const movingEffectsCase = effectCount => {
      const geometry = new THREE.SphereGeometry(0.35, 6, 4);
      const effects = Array.from({ length: effectCount }, (_unused, index) => {
        const effect = new ParticleForceField({
          geometry,
          direction: new THREE.Vector3(),
        });
        effect.position.set(
          (index % 32) * 0.9 - 14,
          (Math.floor(index / 32) % 32) * 0.9 - 14,
          Math.floor(index / (32 * 32)) * 0.9,
        );
        effect.userData.benchmarkBaseX = effect.position.x;
        return effect;
      });

      return {
        name: `Incremental moving spatial effects ${effectCount.toLocaleString()}`,
        benchmarkMode: 'gpu',
        particleCount: 1,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          maxParticles: 1,
          renderer: new NoopRenderer(),
          spatialEffects: effects,
        }),
        beforeUpdate: system => {
          const registry = system.gpuSimulation._gpuSpatialRegistry;
          if (!system.__dynamicSpatialDiagnostics && registry && system.gpuSimulation._gpuSimulationComputeCache) {
            const diagnostics = {
              baselinePipelineBuilds: system.gpuConfigurationStats.pipelineBuilds,
              updates: 0,
              frame: 0,
            };
            const update = registry.update.bind(registry);
            registry.update = (...args) => {
              const result = system.benchmarks.span('benchmark/spatialUpdate', () => update(...args));
              diagnostics.updates += 1;
              return result;
            };
            system.__dynamicSpatialDiagnostics = diagnostics;
          }

          const diagnostics = system.__dynamicSpatialDiagnostics;
          if (!diagnostics) return;
          diagnostics.frame += 1;
          effects.forEach((effect, index) => {
            effect.position.x =
              effect.userData.benchmarkBaseX + Math.sin(diagnostics.frame * 0.08 + index * 0.17) * 0.35;
          });
        },
        validate: system => {
          const diagnostics = system.__dynamicSpatialDiagnostics;
          const stats = system.gpuSpatialStats;
          if (!diagnostics || diagnostics.updates === 0) {
            throw new Error('Dynamic spatial registry updates were not measured.');
          }
          if (system.gpuConfigurationStats.pipelineBuilds !== diagnostics.baselinePipelineBuilds) {
            throw new Error('Moving spatial effects rebuilt the GPU simulation pipeline.');
          }
          if (stats.structuralBuilds !== 1 || stats.bvhRefits === 0) {
            throw new Error(`Moving effects missed the incremental BVH path: ${JSON.stringify(stats)}.`);
          }
          const timing = system.benchmarks.report().metrics['benchmark/spatialUpdate'];
          diagnostics.updateTimeMs = timing.sum;
          diagnostics.updates = timing.count;
          diagnostics.averageRegistryUpdateMs = timing.mean;
          diagnostics.registryStats = stats;
          geometry.dispose();
        },
      };
    };
    const collisionCase = (name, objectCount, updateGeometry) => {
      const collisionScene = new THREE.Scene();
      const sharedGeometry = updateGeometry === 'many' ? null : new THREE.BoxGeometry(1, 1, 1);
      const meshes = Array.from({ length: objectCount }, (_unused, index) => {
        const mesh = new THREE.Mesh(sharedGeometry ?? new THREE.BoxGeometry(1, 1, 1));
        mesh.position.set(index % 32, Math.floor(index / 32), 0);
        collisionScene.add(mesh);
        return mesh;
      });
      const backend = new ThreeGPUCollisionBackend({ world: collisionScene });

      return {
        name,
        benchmarkMode: 'gpu',
        particleCount: 1,
        requireGPU: true,
        create: () => ({
          gpuProcessing: true,
          maxParticles: 1,
          renderer: new NoopRenderer(),
          modules: [new Collision({ backend })],
        }),
        beforeUpdate: system => {
          if (!system.__dynamicSpatialDiagnostics && backend.stats.fullBuilds > 0) {
            const diagnostics = {
              baselinePipelineBuilds: system.gpuConfigurationStats.pipelineBuilds,
              updates: 0,
              frame: 0,
            };
            const update = backend.update.bind(backend);
            backend.update = (...args) => {
              const result = system.benchmarks.span('benchmark/spatialUpdate', () => update(...args));
              diagnostics.updates += 1;
              return result;
            };
            system.__dynamicSpatialDiagnostics = diagnostics;
          }

          const diagnostics = system.__dynamicSpatialDiagnostics;
          if (!diagnostics) return;
          diagnostics.frame += 1;
          if (updateGeometry === 'transform') {
            meshes.forEach((mesh, index) => {
              mesh.position.z = Math.sin(diagnostics.frame * 0.06 + index * 0.03) * 0.25;
            });
          } else if (updateGeometry === 'one' || updateGeometry === 'many') {
            const changed = updateGeometry === 'one' ? meshes.slice(0, 1) : meshes;
            changed.forEach((mesh, index) => {
              const positions = mesh.geometry.attributes.position;
              positions.setX(0, -0.5 + Math.sin(diagnostics.frame * 0.08 + index) * 0.05);
              positions.needsUpdate = true;
            });
          } else if (updateGeometry === 'topology') {
            const geometry = meshes[0].geometry;
            geometry.setDrawRange(0, diagnostics.frame % 2 === 0 ? 30 : 36);
          }
        },
        validate: system => {
          const diagnostics = system.__dynamicSpatialDiagnostics;
          if (!diagnostics || diagnostics.updates === 0) {
            throw new Error('Collision backend updates were not measured.');
          }
          if (system.gpuConfigurationStats.pipelineBuilds !== diagnostics.baselinePipelineBuilds) {
            throw new Error('Dynamic collision data rebuilt the GPU simulation pipeline.');
          }
          if (updateGeometry === 'transform' && backend.stats.fullBuilds !== 1) {
            throw new Error(`Transform updates caused ${backend.stats.fullBuilds} collision repacks.`);
          }
          if (!updateGeometry && backend.stats.transformUpdates !== 0) {
            throw new Error('Static collision geometry scheduled transform uploads.');
          }
          const timing = system.benchmarks.report().metrics['benchmark/spatialUpdate'];
          diagnostics.updateTimeMs = timing.sum;
          diagnostics.updates = timing.count;
          diagnostics.averageBackendUpdateMs = timing.mean;
          diagnostics.collisionStats = { ...backend.stats };
          new Set(meshes.map(mesh => mesh.geometry)).forEach(geometry => geometry.dispose());
        },
      };
    };
    return [
      collisionCase('Static collision meshes 1,000', 1000),
      collisionCase('Moving shared collision instances 1,000', 1000, 'transform'),
      movingEffectsCase(100),
      movingEffectsCase(1000),
      collisionCase('One deforming collision mesh', 1, 'one'),
      collisionCase('Many deforming collision meshes', 16, 'many'),
      collisionCase('Frequent collision topology changes', 1, 'topology'),
    ];
  },
};
