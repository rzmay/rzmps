import * as THREE from 'three';
import { Boids, Collision, ThreeCollisionBackend, ThreeGPUCollisionBackend } from '@rzmps/rzmps';
import { NoopRenderer, pairBenchmarkCases } from './benchmark.utils.js';

export default {
  id: 'spatial-grid',
  name: 'spatial-grid workloads',
  feature: 'spatial/grid',
  runtime: 'browser',
  backends: ['cpu', 'gpu'],
  createCases(_context) {
    return pairBenchmarkCases([
      ...[1_000, 10_000, 100_000].map(particleCount => ({
        name: `Spatial grid Boids ${particleCount.toLocaleString()}`,
        particleCount,
        create: () => ({
          maxParticles: particleCount,
          renderer: new NoopRenderer(),
          modules: [
            new Boids({
              neighborRadius: 0.3,
              spatialGridOptions: {
                bounds: new THREE.Box3(new THREE.Vector3(-16, -16, -16), new THREE.Vector3(16, 16, 16)),
                brickSubdivisions: 3,
                cellSubdivisions: 4,
                autoExpand: true,
              },
            }),
          ],
        }),
      })),
      {
        name: 'Collision static mesh 10k',
        particleCount: 10_000,
        create: mode => {
          const collisionScene = new THREE.Scene();
          const collisionMesh = new THREE.Mesh(new THREE.TorusKnotGeometry(2, 0.5, 256, 32));
          collisionScene.add(collisionMesh);
          const backend =
            mode === 'gpu'
              ? new ThreeGPUCollisionBackend({ world: collisionScene })
              : new ThreeCollisionBackend({ world: collisionScene });
          return {
            maxParticles: 10_000,
            renderer: new NoopRenderer(),
            modules: [new Collision({ backend })],
          };
        },
      },
    ]);
  },
};
