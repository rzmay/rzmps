import * as THREE from 'three';
import Particle from '../Particle';
import acceptMultiple from './acceptMultiple';
import tagsIntersect from './tagsIntersect';
import type { Multiple } from '../types/Multiple';
import type { Tag } from '../types/Tag';

export interface OctreeConfig {
  /** Default rebuild filter; omission or an empty selection includes every tag. */
  tags?: Multiple<Tag>;
  /** Particle-space bounds; particles outside the resolved volume are omitted. */
  bounds: THREE.Box3;
  /** Maximum subdivision depth.
   * @defaultValue 8 */
  maxDepth: number;
  /** Target capacity before further subdivision.
   * @defaultValue 4 */
  particlesPerLeaf: number;
  /** Fraction of calls that rebuild after the initial build, clamped above zero through 1.
   * @defaultValue 1 */
  timeQuality: number;
  /** Bounds quantization increment; zero disables quantization.
   * @defaultValue 0 */
  quantizeBounds: number;
}

export interface OctreeNode<TAggregate = unknown> {
  id: number;
  depth: number;
  maxDepth: boolean;
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  size: number;
  aggregate: TAggregate;
  parent: OctreeNode<TAggregate> | null;
  children: OctreeNode<TAggregate>[];
  neighbors: OctreeNode<TAggregate>[];
  particleIndices: number[];
  isLeaf: boolean;
  isEmpty: boolean;
}

export interface OctreeAggregator<TAggregate> {
  "new"(particle?: Particle, particleIndex?: number, node?: OctreeNode<TAggregate>): TAggregate;
  combine(a: TAggregate, b: TAggregate): TAggregate;
}

export interface ParticleOctreeQueryOptions {
  /** Particle index omitted from the query, normally the caller's own index. */
  excludeIndex?: number;
  /** Requires at least one matching particle tag. */
  tags?: Multiple<Tag>;
}

/** Particle-space octree with caller-defined aggregation; rebuild replaces node identities and may be throttled. */
class ParticleOctree<TAggregate> {
  root: OctreeNode<TAggregate>;
  bounds = new THREE.Box3();
  tags?: Multiple<Tag>;
  timeQuality: number;
  maxDepth: number;
  particlesPerLeaf: number;
  quantizeBounds: number;

  private particles: Particle[] = [];
  private nodeId = 0;
  private nodes: OctreeNode<TAggregate>[] = [];
  private min = new THREE.Vector3();
  private size = 1;
  private updateAccumulator = 0;
  private hasBuiltTree = false;
  private quantizedBounds = new THREE.Box3();
  private boundsCenter = new THREE.Vector3();
  private boundsSize = new THREE.Vector3();

  /** Creates an empty tree and normalizes depth, leaf capacity, and rebuild-quality settings. */
  constructor(
    config: Partial<OctreeConfig>,
    private aggregator: OctreeAggregator<TAggregate>,
  ) {
    this.tags = config.tags;
    this.maxDepth = Math.max(0, Math.floor(config.maxDepth ?? 8));
    this.particlesPerLeaf = Math.max(1, Math.floor(config.particlesPerLeaf ?? 4));
    this.timeQuality = THREE.MathUtils.clamp(config.timeQuality ?? 1, Number.EPSILON, 1);
    this.quantizeBounds = Math.max(0, config.quantizeBounds ?? 0);
    this.setBounds(config.bounds);
    this.root = this.buildNode(0, this.min, this.size, null, []);
    this.assignNeighbors();
  }

  /** Resolves and copies particle-space bounds; call rebuild to populate the new volume. */
  setBounds(bounds?: THREE.Box3): this {
    const nextBounds = bounds ?? new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );
    const boundsSize = new THREE.Vector3();

    this.bounds.copy(this.getResolvedBounds(nextBounds));
    this.bounds.getSize(boundsSize);
    this.min.copy(this.bounds.min);
    this.size = Math.max(boundsSize.x, boundsSize.y, boundsSize.z, Number.EPSILON);

    return this;
  }

  /** Replaces tree nodes and aggregates from the supplied population; returns false when throttled by timeQuality. */
  rebuild(particles: Particle[], tags: Multiple<Tag> | undefined = this.tags): boolean {
    this.updateAccumulator += this.timeQuality;

    if (this.hasBuiltTree && this.updateAccumulator < 1) return false;

    this.updateAccumulator = Math.max(0, this.updateAccumulator - 1);
    this.particles = particles.slice();
    this.nodeId = 0;
    this.nodes = [];

    const acceptedTags = acceptMultiple(tags);
    const useTags = Boolean(acceptedTags?.length);
    const particleIndices = this.particles
      .map((_particle, index) => index)
      .filter((index) => (
        this.containsPosition(this.particles[index].position)
        && (!useTags || (
          acceptedTags
          && tagsIntersect(acceptedTags, this.particles[index].tags ?? [])
        ))
      ));

    this.root = this.buildNode(0, this.min, this.size, null, particleIndices);
    this.assignNeighbors();
    this.hasBuiltTree = true;

    return true;
  }

  /** Returns the deepest containing node up to maxDepth; positions outside the volume return the root. */
  locate(position: THREE.Vector3, maxDepth: number = this.maxDepth): OctreeNode<TAggregate> {
    if (!this.containsPosition(position)) return this.root;

    let node = this.root;
    const targetDepth = Math.max(0, Math.min(Math.floor(maxDepth), this.maxDepth));

    while (node.depth < targetDepth && node.children.length > 0) {
      const child = node.children.find((candidate) => this.containsPosition(position, candidate));
      if (!child) break;
      node = child;
    }

    return node;
  }

  /** Returns a new array of current node references; node identities are replaced on rebuild. */
  getNodes(): OctreeNode<TAggregate>[] {
    return [...this.nodes];
  }

  /** Estimates local separation from a bounded sample of the leaf and its neighbors.
   * Isolated particles fall back to their visual extent. No neighbor array is allocated.
   */
  estimateSpacing(particle: Particle): number {
    const fallback = Math.max(particle.scale.length() * 0.5, 0.001);
    const leaf = this.locate(particle.position);
    let nearestSquared = (fallback * 8) ** 2;
    let found = false;
    let inspected = 0;
    const sample = (node: OctreeNode<TAggregate>) => {
      const indices = node.particleIndices;
      const stride = Math.max(1, Math.floor(indices.length / 16));
      for (let i = 0; i < indices.length && inspected < 64; i += stride) {
        const other = this.particles[indices[i]];
        inspected++;
        if (!other.alive || other.id === particle.id) continue;
        const distance = other.position.distanceToSquared(particle.position);
        if (distance < nearestSquared) { nearestSquared = distance; found = true; }
      }
    };
    sample(leaf);
    for (const neighbor of leaf.neighbors) {
      if (inspected >= 64) break;
      sample(neighbor);
    }
    return found ? Math.sqrt(nearestSquared) * 0.5 : fallback;
  }

  /** Returns particles inside an exact radius after pruning nonintersecting octree nodes. */
  particlesInRadius(
    position: THREE.Vector3,
    radius: number,
    options: ParticleOctreeQueryOptions = {},
  ): Particle[] {
    const resolvedRadius = Math.max(0, radius);
    if (Number.isNaN(resolvedRadius) || this.root.isEmpty) return [];

    const acceptedTags = acceptMultiple(options.tags);
    const particles: Particle[] = [];
    this.visitNodeInRadius(
      this.root,
      position,
      resolvedRadius * resolvedRadius,
      particles,
      options.excludeIndex,
      acceptedTags,
    );
    return particles;
  }

  private visitNodeInRadius(
    node: OctreeNode<TAggregate>,
    position: THREE.Vector3,
    radiusSquared: number,
    particles: Particle[],
    excludeIndex?: number,
    tags?: Tag[],
  ): void {
    let nodeDistanceSquared = 0;
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = position[axis];
      if (value < node.min[axis]) nodeDistanceSquared += (node.min[axis] - value) ** 2;
      else if (value > node.max[axis]) nodeDistanceSquared += (value - node.max[axis]) ** 2;
    }
    if (nodeDistanceSquared > radiusSquared) return;

    if (!node.isLeaf) {
      node.children.forEach((child) => {
        this.visitNodeInRadius(
          child,
          position,
          radiusSquared,
          particles,
          excludeIndex,
          tags,
        );
      });
      return;
    }

    node.particleIndices.forEach((particleIndex) => {
      if (particleIndex === excludeIndex) return;
      const particle = this.particles[particleIndex];
      if (!particle || (tags?.length && !tagsIntersect(tags, particle.tags ?? []))) return;

      const distanceSquared = particle.position.distanceToSquared(position);
      if (distanceSquared <= radiusSquared) particles.push(particle);
    });
  }

  private buildNode(
    depth: number,
    min: THREE.Vector3,
    size: number,
    parent: OctreeNode<TAggregate> | null,
    particleIndices: number[],
  ): OctreeNode<TAggregate> {
    const nodeMin = min.clone();
    const nodeMax = nodeMin.clone().addScalar(size);
    const node: OctreeNode<TAggregate> = {
      id: this.nodeId++,
      depth,
      maxDepth: depth === this.maxDepth,
      min: nodeMin,
      max: nodeMax,
      center: nodeMin.clone().addScalar(size * 0.5),
      size,
      aggregate: undefined as TAggregate,
      parent,
      children: [],
      neighbors: [],
      particleIndices: [...particleIndices],
      isLeaf: true,
      isEmpty: particleIndices.length === 0,
    };

    node.aggregate = this.aggregator.new(undefined, undefined, node);
    this.nodes.push(node);

    if (
      depth < this.maxDepth
      && particleIndices.length > this.particlesPerLeaf
    ) {
      const halfSize = size * 0.5;
      const childIndices: number[][] = Array.from({ length: 8 }, () => []);

      particleIndices.forEach((particleIndex) => {
        const position = this.particles[particleIndex].position;
        const octant = (position.x >= node.center.x ? 1 : 0)
          + (position.y >= node.center.y ? 2 : 0)
          + (position.z >= node.center.z ? 4 : 0);
        childIndices[octant].push(particleIndex);
      });

      childIndices.forEach((indices, octant) => {
        if (indices.length === 0) return;

        node.children.push(this.buildNode(
          depth + 1,
          new THREE.Vector3(
            node.min.x + ((octant & 1) ? halfSize : 0),
            node.min.y + ((octant & 2) ? halfSize : 0),
            node.min.z + ((octant & 4) ? halfSize : 0),
          ),
          halfSize,
          node,
          indices,
        ));
      });
    }

    node.isLeaf = node.children.length === 0;

    if (node.isLeaf) {
      node.particleIndices.forEach((particleIndex) => {
        node.aggregate = this.aggregator.combine(
          node.aggregate,
          this.aggregator.new(this.particles[particleIndex], particleIndex, node),
        );
      });
    } else {
      node.children.forEach((child) => {
        node.aggregate = this.aggregator.combine(node.aggregate, child.aggregate);
      });
    }

    return node;
  }

  private assignNeighbors(): void {
    this.nodes.forEach((node) => {
      const neighbors = new Map<number, OctreeNode<TAggregate>>();

      for (let x = -1; x <= 1; x += 1) {
        for (let y = -1; y <= 1; y += 1) {
          for (let z = -1; z <= 1; z += 1) {
            if (x === 0 && y === 0 && z === 0) continue;

            const neighborPosition = new THREE.Vector3(
              node.center.x + x * node.size,
              node.center.y + y * node.size,
              node.center.z + z * node.size,
            );

            if (!this.containsPosition(neighborPosition)) continue;

            const neighbor = this.locate(neighborPosition, node.depth);
            if (neighbor.id !== node.id) neighbors.set(neighbor.id, neighbor);
          }
        }
      }

      node.neighbors = Array.from(neighbors.values());
    });
  }

  private containsPosition(position: THREE.Vector3, node?: OctreeNode<TAggregate>): boolean {
    const min = node?.min ?? this.min;
    const size = node?.size ?? this.size;

    return position.x >= min.x && position.x <= min.x + size
      && position.y >= min.y && position.y <= min.y + size
      && position.z >= min.z && position.z <= min.z + size;
  }

  private getResolvedBounds(bounds: THREE.Box3): THREE.Box3 {
    if (this.quantizeBounds <= 1) return bounds;

    bounds.getCenter(this.boundsCenter);
    bounds.getSize(this.boundsSize);

    const rawSize = Math.max(
      this.boundsSize.x,
      this.boundsSize.y,
      this.boundsSize.z,
      Number.EPSILON,
    );
    const base = this.quantizeBounds;
    const size = base ** Math.ceil(Math.log(rawSize) / Math.log(base));
    const halfSize = size * 0.5;

    this.boundsCenter.set(
      Math.round(this.boundsCenter.x / halfSize) * halfSize,
      Math.round(this.boundsCenter.y / halfSize) * halfSize,
      Math.round(this.boundsCenter.z / halfSize) * halfSize,
    );

    return this.quantizedBounds.setFromCenterAndSize(
      this.boundsCenter,
      this.boundsSize.set(size, size, size),
    );
  }
}

export default ParticleOctree;
