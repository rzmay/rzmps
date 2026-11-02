import { Box3, Vector3 } from 'three';
import Particle from '../Particle';
import ParticleOctree, { type OctreeNode } from './ParticleOctree';
import type ParticleSystem from '../ParticleSystem';

/** Nearest integer, with positive halves rounded up; negative count means unlimited. */
export function rendererGroupCount(n: number, count: number, ratio: number): number {
  const limit = count < 0 ? Infinity : count;
  const target = Math.min(limit, Math.max(0, ratio) * n);
  return Number.isNaN(target) ? 0 : Math.max(0, Math.min(n, Math.round(target)));
}

/** Entirely frame-local render transformation. No memberships survive this call. */
export default function groupRendererParticles(
  particles: Particle[], count: number, ratio: number, radius: number, system: ParticleSystem,
): Particle[] {
  const k = rendererGroupCount(particles.length, count, ratio);
  if (k >= particles.length) return particles;
  if (!k) return [];

  // Select representative regions from source counts and position sums in world space.
  const world = particles.map(p => system.simulationSpace === 'world'
    ? p.position : p.position.clone().applyMatrix4(system.matrixWorld));
  const bounds = new Box3().setFromPoints(world);
  const sourceTree = new ParticleOctree({ bounds, particlesPerLeaf: 8 }, {
    new: (p?: Particle) => ({ count: p ? 1 : 0, sum: p?.position.clone() ?? new Vector3() }),
    combine: (a, b) => ({ count: a.count + b.count, sum: a.sum.clone().add(b.sum) }),
  });
  sourceTree.rebuild(particles.map((p, i) => p.shallowClone(p.id, { position: world[i] })));

  const anchors: number[] = [];
  const scales: number[] = [];
  const select = (node: typeof sourceTree.root, budget: number) => {
    if (!budget) return;

    const aggregate = sourceTree.getAggregate(node);
    if (budget === 1 || node.isLeaf) {
      const centroid = aggregate.sum.clone().divideScalar(aggregate.count);
      const indices = [...node.particleIndices].sort((a, b) => particles[a].id.localeCompare(particles[b].id));
      for (let ordinal = 0; ordinal < budget; ordinal++) {
        let anchor = indices[Math.floor(ordinal * indices.length / budget)];

        if (budget === 1) {
          let distance = world[anchor].distanceToSquared(centroid);
          for (const i of indices) {
            const d = world[i].distanceToSquared(centroid);
            if (d < distance - 1e-12) {
              distance = d;
              anchor = i;
            }
          }
        }
        anchors.push(anchor);
        scales.push(Math.max(1e-12, node.min.distanceToSquared(node.max)));
      }

      return;
    }

    let preceding = 0;
    let assigned = 0;
    for (const child of sourceTree.getChildren(node)) {
      preceding += child.aggregate.count;
      const end = Math.floor(budget * preceding / aggregate.count);
      select(child, end - assigned);
      assigned = end;
    }
  };
  select(sourceTree.root, k);

  const order = particles.map((_p, i) => ({ i }));
  const centers = anchors.map(i => particles[i].shallowClone(particles[i].id, { position: world[i] }));

  // Coincident centers retain distinct anchors but need only one nearest-query entry.
  const spatialCenters = new Map<string, number>();
  centers.forEach((p, i) => {
    const key = `${p.position.x},${p.position.y},${p.position.z}`;
    if (!spatialCenters.has(key)) spatialCenters.set(key, i);
  });

  const centerIndices = [...spatialCenters.values()];
  const centerBounds = new Box3().setFromPoints(centers.map(p => p.position));
  const tree = new ParticleOctree<number>({ bounds: centerBounds, particlesPerLeaf: 8 }, {
    new: p => p ? 1 : 0, combine: (a, b) => a + b,
  });
  tree.rebuild(centerIndices.map(i => centers[i]));

  // Assign exact nearest-anchor memberships, retaining each anchor's own particle.
  const anchorGroups = new Map(anchors.map((a, i) => [a, i]));
  const groups: number[][] = anchors.map(() => []);
  const limit = radius < 0 ? Infinity : radius * radius;
  for (const { i } of order) {
    let best = anchorGroups.get(i) ?? -1;
    let distance = best < 0 ? limit : 0;
    const visit = (node: OctreeNode<number>) => {
      let d = 0;
      for (const axis of ['x', 'y', 'z'] as const) {
        d += Math.max(node.min[axis] - world[i][axis], 0, world[i][axis] - node.max[axis]) ** 2;
      }
      if (d > distance) return;
      if (!node.isLeaf) {
        node.children.forEach(visit);
        return;
      }
      for (const index of node.particleIndices) {
        const g = centerIndices[index];
        const next = world[i].distanceToSquared(centers[g].position);
        if (next < distance || (next === distance && (best < 0 || g < best) && !anchorGroups.has(i))) {
          distance = next;
          best = g;
        }
      }
    };
    if (best < 0) visit(tree.root);
    if (best >= 0) groups[best].push(i);
  }

  // Average visual channels; mass and contribution remain additive.
  return groups.map((members, g) => {
    if (members.length === 1) return particles[members[0]];

    const anchor = particles[anchors[g]];
    const aggregate = anchor.shallowClone(anchor.id);
    members.sort((a, b) => particles[a].id.localeCompare(particles[b].id));
    let scaleSquared = scales[g];
    if (radius > 0) scaleSquared = radius * radius;
    const weights = members.map(i => 1 / (1 + world[i].distanceToSquared(centers[g].position) / scaleSquared));
    const sum = weights.reduce((a, b) => a + b, 0);

    for (const field of ['position', 'orbitCenter', 'rotation', 'scale', 'velocity', 'angularVelocity',
      'scalarVelocity', 'acceleration', 'angularAcceleration', 'scalarAcceleration'] as const) {
      aggregate[field] = new Vector3();
      members.forEach((i, j) => aggregate[field].addScaledVector(particles[i][field], weights[j] / sum));
    }
    aggregate.color = anchor.color.clone().multiplyScalar(0);
    members.forEach((i, j) => {
      const w = weights[j] / sum;
      aggregate.color.r += particles[i].color.r * w;
      aggregate.color.g += particles[i].color.g * w;
      aggregate.color.b += particles[i].color.b * w;
    });
    for (const field of ['alpha', 'speed', 'lifetime', 'time', 'realtime', 'distortionStrength'] as const) {
      aggregate[field] = members.reduce((v, i, j) => v + particles[i][field] * weights[j] / sum, 0);
    }
    aggregate.mass = members.reduce((v, i) => v + particles[i].mass, 0);
    aggregate.contribution = members.reduce((v, i) => v + particles[i].contribution, 0);

    return aggregate;
  });
}
