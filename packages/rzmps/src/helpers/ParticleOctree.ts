import * as THREE from 'three';
import Particle from '../Particle';
import acceptMultiple from './acceptMultiple';
import tagsIntersect from './tagsIntersect';
import type { Multiple } from '../types/Multiple';
import type { Tag } from '../types/Tag';

export interface OctreeConfig {
  bounds?: THREE.Box3;
  maxDepth: number;
  maxParticlesPerLeaf: number;
  timeQuality?: number;
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
  "new"(particle?: Particle, particleIndex?: number): TAggregate;
  combine(a: TAggregate, b: TAggregate): TAggregate;
}

class ParticleOctree<TAggregate> {
  root: OctreeNode<TAggregate>;
  timeQuality: number;

  private particles: Particle[] = [];
  private nodeId = 0;
  private nodes: OctreeNode<TAggregate>[] = [];
  private min = new THREE.Vector3();
  private size = 1;
  private updateAccumulator = 0;
  private hasBuiltTree = false;

  constructor(
    public config: OctreeConfig,
    private aggregator: OctreeAggregator<TAggregate>,
  ) {
    this.sanitizeConfig();
    this.timeQuality = THREE.MathUtils.clamp(this.config.timeQuality ?? 1, Number.EPSILON, 1);
    this.root = this.buildNode(0, this.min, this.size, null, []);
    this.assignNeighbors();
  }

  rebuild(particles: Particle[], tags?: Multiple<Tag>): boolean {
    this.updateAccumulator += this.timeQuality;

    if (this.hasBuiltTree && this.updateAccumulator < 1) return false;

    this.updateAccumulator = Math.max(0, this.updateAccumulator - 1);
    this.particles = particles.slice();
    this.nodeId = 0;
    this.nodes = [];
    this.sanitizeConfig();

    const acceptedTags = acceptMultiple(tags);
    const useTags = Boolean(acceptedTags?.length);
    const particleIndices = this.particles
      .map((_particle, index) => index)
      .filter((index) => (
        this.containsPosition(this.particles[index].position)
        && (!useTags || tagsIntersect(acceptedTags!, this.particles[index].tags ?? []))
      ));

    this.root = this.buildNode(0, this.min, this.size, null, particleIndices);
    this.assignNeighbors();
    this.hasBuiltTree = true;

    return true;
  }

  locate(position: THREE.Vector3, maxDepth: number = this.config.maxDepth): OctreeNode<TAggregate> {
    if (!this.containsPosition(position)) return this.root;

    let node = this.root;
    const targetDepth = Math.max(0, Math.min(Math.floor(maxDepth), this.config.maxDepth));

    while (node.depth < targetDepth && node.children.length > 0) {
      const child = node.children.find((candidate) => this.containsPosition(position, candidate));
      if (!child) break;
      node = child;
    }

    return node;
  }

  getNodes(): OctreeNode<TAggregate>[] {
    return [...this.nodes];
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
      maxDepth: depth === this.config.maxDepth,
      min: nodeMin,
      max: nodeMax,
      center: nodeMin.clone().addScalar(size * 0.5),
      size,
      aggregate: this.aggregator.new(),
      parent,
      children: [],
      neighbors: [],
      particleIndices: [...particleIndices],
      isLeaf: true,
      isEmpty: particleIndices.length === 0,
    };

    this.nodes.push(node);

    if (
      depth < this.config.maxDepth
      && particleIndices.length > this.config.maxParticlesPerLeaf
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
          this.aggregator.new(this.particles[particleIndex], particleIndex),
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

  private sanitizeConfig(): void {
    this.config.maxDepth = Math.max(0, Math.floor(this.config.maxDepth));
    this.config.maxParticlesPerLeaf = Math.max(1, Math.floor(this.config.maxParticlesPerLeaf));

    const boundsSize = new THREE.Vector3();
    const bounds = this.config.bounds ?? new THREE.Box3(
      new THREE.Vector3(-0.5, -0.5, -0.5),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );

    bounds.getSize(boundsSize);
    this.min.copy(bounds.min);
    this.size = Math.max(boundsSize.x, boundsSize.y, boundsSize.z, Number.EPSILON);
  }
}

export default ParticleOctree;
