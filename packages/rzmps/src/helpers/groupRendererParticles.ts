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

// Ten bits per axis, interleaved in XYZ order. Occupancy in this spatial ordering
// guides balanced hierarchical subdivision, independent of particle array order.
export function rendererMortonCode(p: Vector3, min: Vector3, size: number): number {
  const spread = (v: number) => {
    v = Math.max(0, Math.min(1023, Math.floor(v)));
    v = (v | (v << 16)) & 0x030000ff;
    v = (v | (v << 8)) & 0x0300f00f;
    v = (v | (v << 4)) & 0x030c30c3;
    return (v | (v << 2)) & 0x09249249;
  };
  return spread((p.x - min.x) / size * 1023)
    | (spread((p.y - min.y) / size * 1023) << 1)
    | (spread((p.z - min.z) / size * 1023) << 2);
}

/** Entirely frame-local render transformation. No memberships survive this call. */
export default function groupRendererParticles(
  particles: Particle[], count: number, ratio: number, radius: number, system: ParticleSystem,
): Particle[] {
  const k = rendererGroupCount(particles.length, count, ratio);
  if (k >= particles.length) return particles;
  if (!k) return [];
  const world = particles.map(p => system.simulationSpace === 'world'
    ? p.position : p.position.clone().applyMatrix4(system.matrixWorld));
  const bounds = new Box3().setFromPoints(world);
  const extent = bounds.getSize(new Vector3());
  // Quantized power-of-two bounds keep cell coordinates fixed during small motion.
  const size = 2 ** Math.ceil(Math.log2(Math.max(extent.x, extent.y, extent.z, 1e-6) * 17 / 16));
  const increment = size / 16;
  bounds.min.divideScalar(increment).floor().multiplyScalar(increment);
  const order = particles.map((p, i) => ({ i, code: rendererMortonCode(world[i], bounds.min, size) }));
  order.sort((a, b) => a.code - b.code || world[a.i].x - world[b.i].x
    || world[a.i].y - world[b.i].y || world[a.i].z - world[b.i].z
    || particles[a.i].id.localeCompare(particles[b.i].id));
  // Split the most occupied region first. Equal occupancy favors the earliest
  // spatial region. Dense cells can be subdivided even at identical positions.
  const regions = [{ start: 0, length: order.length }];
  const heap = [0];
  const preferred = (a: number, b: number) => regions[a].length > regions[b].length
    || (regions[a].length === regions[b].length && regions[a].start < regions[b].start);
  const push = (index: number) => {
    heap.push(index);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!preferred(heap[i], heap[parent])) break;
      [heap[i], heap[parent]] = [heap[parent], heap[i]]; i = parent;
    }
  };
  const pop = () => {
    const result = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && preferred(heap[child + 1], heap[child])) child++;
        if (!preferred(heap[child], heap[i])) break;
        [heap[i], heap[child]] = [heap[child], heap[i]]; i = child;
      }
    }
    return result;
  };
  while (regions.length < k) {
    const index = pop();
    const region = regions[index];
    const half = Math.floor(region.length / 2);
    regions.push({ start: region.start + half, length: region.length - half });
    region.length = half;
    if (half > 1) push(index);
    if (regions[regions.length - 1].length > 1) push(regions.length - 1);
  }
  const anchors = regions.map(region => {
    const centroid = new Vector3();
    for (let j = region.start; j < region.start + region.length; j++) centroid.add(world[order[j].i]);
    centroid.divideScalar(region.length);
    let anchor = order[region.start].i;
    let distance = Infinity;
    for (let j = region.start; j < region.start + region.length; j++) {
      const i = order[j].i;
      const d = world[i].distanceToSquared(centroid);
      if (d < distance) { distance = d; anchor = i; }
    }
    return anchor;
  });
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
  const anchorGroups = new Map(anchors.map((a, i) => [a, i]));
  const groups: number[][] = regions.map(() => []);
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
      if (!node.isLeaf) { node.children.forEach(visit); return; }
      for (const index of node.particleIndices) {
        const g = centerIndices[index];
        const next = world[i].distanceToSquared(centers[g].position);
        if (next < distance || (next === distance && (best < 0 || g < best) && !anchorGroups.has(i))) {
          distance = next; best = g;
        }
      }
    };
    if (best < 0) visit(tree.root);
    if (best >= 0) groups[best].push(i);
  }
  return groups.map((members, g) => {
    if (members.length === 1) return particles[members[0]];
    const anchor = particles[anchors[g]];
    const aggregate = anchor.shallowClone(anchor.id);
    let scaleSquared = 1e-12;
    const region = regions[g];
    for (let j = region.start; j < region.start + region.length; j++) {
      scaleSquared = Math.max(scaleSquared, world[order[j].i].distanceToSquared(centers[g].position));
    }
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
