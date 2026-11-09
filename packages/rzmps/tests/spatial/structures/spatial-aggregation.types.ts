import { Vector3 } from 'three';
import { uint, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { ParticleOctree, ParticleSpatialGrid, ParticleSystem, SpatialLevels, type SpatialAggregator }
  from '../../../build/index.mjs';

const cpu: SpatialAggregator<{ count: number; sum: Vector3 }> = {
  new: p => ({ count: p ? 1 : 0, sum: p?.position.clone() ?? new Vector3() }),
  combine: (a, b) => ({ count: a.count + b.count, sum: a.sum.clone().add(b.sum) }),
};
new ParticleOctree({}, cpu);
const gpu: SpatialAggregator<{ count: 'uint'; sum: 'vec3' }, 'gpu'> = {
  layout: { count: 'uint', sum: 'vec3' },
  new: p => ({ count: uint(p ? 1 : 0), sum: p?.position ?? vec3(0) }),
  combine: (a, b) => ({ count: a.count.add(b.count), sum: a.sum.add(b.sum) }),
};
const grid = new ParticleSpatialGrid({ levels: 'Cells' }, gpu);
const region = grid.locateNode(vec3(0));
const count: Node<'uint'> = grid.getAggregate(region).count;
void count;
new ParticleSpatialGrid({ levels: SpatialLevels.All });
new ParticleSpatialGrid({ levels: '*' });
new ParticleSpatialGrid({ levels: [0, 2] as const });
// @ts-expect-error A CPU aggregate cannot masquerade as a GPU node/layout contract.
new ParticleSpatialGrid({}, cpu);
// @ts-expect-error Depth presets are enum keys/values, not arbitrary strings.
new ParticleSpatialGrid({ levels: 'everything' });
const inferred = new ParticleSpatialGrid({}, {
  layout: { count: 'uint' },
  new: p => ({ count: uint(p ? 1 : 0) }),
  combine: (a, b) => ({ count: a.count.add(b.count) }),
});
const inferredCount: Node<'uint'> = inferred.getAggregate(region).count;
void inferredCount;
new ParticleSystem({ emitters: [], modules: [], renderers: [] }).acquireParticleSpatialGrid(grid);
