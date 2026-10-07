import * as THREE from 'three';
import Particle from '../Particle';
import acceptMultiple from './acceptMultiple';
import tagsIntersect from './tagsIntersect';
import type { Multiple } from '../types/Multiple';
import type { Tag } from '../types/Tag';

export interface OctreeConfig {
  bounds: THREE.Box3;
  maxDepth: number;
  particlesPerLeaf: number;
  timeQuality: number;
  quantizeBounds: number;
  brickLevel?: number;
}

export interface OctreeBrick<TAggregate = unknown> {
  resolution: number;
  nodes: Array<OctreeNode<TAggregate> | undefined>;
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
  brick?: OctreeBrick<TAggregate>;
}

export interface OctreeGridCell<TAggregate = unknown> {
  x: number;
  y: number;
  z: number;
  min: THREE.Vector3;
  max: THREE.Vector3;
  center: THREE.Vector3;
  size: number;
  aggregate: TAggregate;
  node: OctreeNode<TAggregate>;
  exact: boolean;
}

export interface OctreeAggregator<TAggregate> {
  "new"(particle?: Particle, particleIndex?: number, node?: OctreeNode<TAggregate>): TAggregate;
  combine(a: TAggregate, b: TAggregate): TAggregate;
}

class ParticleOctree<TAggregate> {
  root: OctreeNode<TAggregate>;
  bounds = new THREE.Box3();
  timeQuality: number;
  maxDepth: number;
  particlesPerLeaf: number;
  quantizeBounds: number;
  brickLevel: number;

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
  private resolvedBrickLevel = 0;
  private brickResolution = 1;

  constructor(
    config: Partial<OctreeConfig>,
    private aggregator: OctreeAggregator<TAggregate>,
  ) {
    this.maxDepth = Math.max(0, Math.floor(config.maxDepth ?? 8));
    this.particlesPerLeaf = Math.max(1, Math.floor(config.particlesPerLeaf ?? 4));
    this.timeQuality = THREE.MathUtils.clamp(config.timeQuality ?? 1, Number.EPSILON, 1);
    this.quantizeBounds = Math.max(0, config.quantizeBounds ?? 0);
    this.brickLevel = Math.floor(config.brickLevel ?? -3);
    this.resolveBrickLevel();
    this.setBounds(config.bounds);
    this.root = this.buildNode(0, this.min, this.size, null, []);
    this.buildBricks();
    this.assignNeighbors();
  }

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

  rebuild(particles: Particle[], tags?: Multiple<Tag>): boolean {
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
    this.buildBricks();
    this.assignNeighbors();
    this.hasBuiltTree = true;

    return true;
  }

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

  getNodes(): OctreeNode<TAggregate>[] {
    return [...this.nodes];
  }

  getGridResolution(): number {
    return 2 ** this.maxDepth;
  }

  worldToGrid(position: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
    const resolution = this.getGridResolution();

    target.set(
      this.worldAxisToGrid(position.x, this.min.x, resolution),
      this.worldAxisToGrid(position.y, this.min.y, resolution),
      this.worldAxisToGrid(position.z, this.min.z, resolution),
    );

    return target;
  }

  gridToWorld(
    x: number,
    y: number,
    z: number,
    target = new THREE.Vector3(),
  ): THREE.Vector3 {
    const cellSize = this.size / this.getGridResolution();

    target.set(
      this.min.x + (this.clampGridCoordinate(x) + 0.5) * cellSize,
      this.min.y + (this.clampGridCoordinate(y) + 0.5) * cellSize,
      this.min.z + (this.clampGridCoordinate(z) + 0.5) * cellSize,
    );

    return target;
  }

  getGridCell(
    x: number,
    y: number,
    z: number,
    exact = false,
  ): OctreeGridCell<TAggregate> {
    const gridX = this.clampGridCoordinate(x);
    const gridY = this.clampGridCoordinate(y);
    const gridZ = this.clampGridCoordinate(z);
    const cellBounds = this.getGridCellBounds(gridX, gridY, gridZ);
    const brickNode = this.locateFrom(
      this.root,
      cellBounds.center,
      this.resolvedBrickLevel,
    );
    const localX = gridX % this.brickResolution;
    const localY = gridY % this.brickResolution;
    const localZ = gridZ % this.brickResolution;
    const brickIndex = this.getBrickIndex(localX, localY, localZ, this.brickResolution);
    const brickCell = brickNode.depth === this.resolvedBrickLevel
      ? brickNode.brick?.nodes[brickIndex]
      : undefined;

    if (brickCell) return this.createGridCell(gridX, gridY, gridZ, cellBounds, brickCell, true);

    const leaf = this.locateFrom(brickNode, cellBounds.center, this.maxDepth);

    if (!exact || leaf.depth === this.maxDepth) {
      return this.createGridCell(gridX, gridY, gridZ, cellBounds, leaf, leaf.depth === this.maxDepth);
    }

    let aggregate = this.aggregator.new(undefined, undefined, leaf);

    leaf.particleIndices.forEach((particleIndex) => {
      const particle = this.particles[particleIndex];

      if (!particle) return;

      const coordinate = this.worldToGrid(particle.position);
      if (coordinate.x !== gridX || coordinate.y !== gridY || coordinate.z !== gridZ) return;

      aggregate = this.aggregator.combine(
        aggregate,
        this.aggregator.new(particle, particleIndex, leaf),
      );
    });

    return {
      ...this.createGridCell(gridX, gridY, gridZ, cellBounds, leaf, true),
      aggregate,
    };
  }

  sampleGrid(position: THREE.Vector3, exact = false): OctreeGridCell<TAggregate> {
    const coordinate = this.worldToGrid(position);

    return this.getGridCell(coordinate.x, coordinate.y, coordinate.z, exact);
  }

  forEachGridCell(
    callback: (cell: OctreeGridCell<TAggregate>) => void,
    options: { exact?: boolean; occupiedOnly?: boolean } = {},
  ): void {
    const resolution = this.getGridResolution();

    if (options.occupiedOnly) {
      const visited = new Set<string>();

      this.root.particleIndices.forEach((particleIndex) => {
        const particle = this.particles[particleIndex];
        if (!particle) return;

        const coordinate = this.worldToGrid(particle.position);
        const key = `${coordinate.x},${coordinate.y},${coordinate.z}`;

        if (visited.has(key)) return;
        visited.add(key);
        callback(this.getGridCell(coordinate.x, coordinate.y, coordinate.z, options.exact));
      });

      return;
    }

    for (let z = 0; z < resolution; z += 1) {
      for (let y = 0; y < resolution; y += 1) {
        for (let x = 0; x < resolution; x += 1) {
          callback(this.getGridCell(x, y, z, options.exact));
        }
      }
    }
  }

  getGridNeighbors(
    x: number,
    y: number,
    z: number,
    radius = 1,
    exact = false,
  ): OctreeGridCell<TAggregate>[] {
    const neighbors: OctreeGridCell<TAggregate>[] = [];
    const distance = Math.max(0, Math.floor(radius));
    const resolution = this.getGridResolution();

    for (let dz = -distance; dz <= distance; dz += 1) {
      for (let dy = -distance; dy <= distance; dy += 1) {
        for (let dx = -distance; dx <= distance; dx += 1) {
          const sampleX = x + dx;
          const sampleY = y + dy;
          const sampleZ = z + dz;

          if (
            sampleX < 0 || sampleX >= resolution
            || sampleY < 0 || sampleY >= resolution
            || sampleZ < 0 || sampleZ >= resolution
          ) {
            continue;
          }

          neighbors.push(this.getGridCell(sampleX, sampleY, sampleZ, exact));
        }
      }
    }

    return neighbors;
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

  private resolveBrickLevel(): void {
    if (this.maxDepth <= 0) {
      this.resolvedBrickLevel = 0;
      this.brickResolution = 1;
      return;
    }

    const rawBrickLevel = this.brickLevel >= 0
      ? this.brickLevel
      : this.maxDepth + this.brickLevel;

    this.resolvedBrickLevel = THREE.MathUtils.clamp(
      rawBrickLevel,
      0,
      this.maxDepth - 1,
    );
    this.brickResolution = 2 ** (this.maxDepth - this.resolvedBrickLevel);
  }

  private buildBricks(): void {
    this.nodes.forEach((node) => {
      node.brick = undefined;
    });

    this.nodes
      .filter((node) => node.depth === this.resolvedBrickLevel)
      .forEach((node) => {
        const brick: OctreeBrick<TAggregate> = {
          resolution: this.brickResolution,
          nodes: Array(this.brickResolution ** 3).fill(undefined),
        };

        this.collectMaxDepthNodes(node, (descendant) => {
          const cellSize = this.size / this.getGridResolution();
          const localX = this.clampBrickCoordinate((descendant.min.x - node.min.x) / cellSize);
          const localY = this.clampBrickCoordinate((descendant.min.y - node.min.y) / cellSize);
          const localZ = this.clampBrickCoordinate((descendant.min.z - node.min.z) / cellSize);
          const brickIndex = this.getBrickIndex(localX, localY, localZ, this.brickResolution);

          brick.nodes[brickIndex] = descendant;
        });

        if (brick.nodes.some(Boolean)) node.brick = brick;
      });
  }

  private collectMaxDepthNodes(
    node: OctreeNode<TAggregate>,
    callback: (node: OctreeNode<TAggregate>) => void,
  ): void {
    if (node.depth === this.maxDepth) {
      callback(node);
      return;
    }

    node.children.forEach((child) => this.collectMaxDepthNodes(child, callback));
  }

  private locateFrom(
    startNode: OctreeNode<TAggregate>,
    position: THREE.Vector3,
    maxDepth: number,
  ): OctreeNode<TAggregate> {
    let node = startNode;
    const targetDepth = Math.max(0, Math.min(Math.floor(maxDepth), this.maxDepth));

    while (node.depth < targetDepth && node.children.length > 0) {
      const child = node.children.find((candidate) => this.containsPosition(position, candidate));
      if (!child) break;
      node = child;
    }

    return node;
  }

  private createGridCell(
    x: number,
    y: number,
    z: number,
    bounds: {
      min: THREE.Vector3;
      max: THREE.Vector3;
      center: THREE.Vector3;
      size: number;
    },
    node: OctreeNode<TAggregate>,
    exact: boolean,
  ): OctreeGridCell<TAggregate> {
    return {
      x,
      y,
      z,
      min: bounds.min,
      max: bounds.max,
      center: bounds.center,
      size: bounds.size,
      aggregate: node.aggregate,
      node,
      exact,
    };
  }

  private getGridCellBounds(x: number, y: number, z: number): {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    size: number;
  } {
    const cellSize = this.size / this.getGridResolution();
    const min = new THREE.Vector3(
      this.min.x + x * cellSize,
      this.min.y + y * cellSize,
      this.min.z + z * cellSize,
    );
    const max = min.clone().addScalar(cellSize);

    return {
      min,
      max,
      center: min.clone().addScalar(cellSize * 0.5),
      size: cellSize,
    };
  }

  private worldAxisToGrid(value: number, min: number, resolution: number): number {
    const coordinate = Math.floor(((value - min) / this.size) * resolution);

    return THREE.MathUtils.clamp(coordinate, 0, resolution - 1);
  }

  private clampGridCoordinate(value: number): number {
    return THREE.MathUtils.clamp(Math.floor(value), 0, this.getGridResolution() - 1);
  }

  private clampBrickCoordinate(value: number): number {
    return THREE.MathUtils.clamp(Math.floor(value), 0, this.brickResolution - 1);
  }

  private getBrickIndex(x: number, y: number, z: number, resolution: number): number {
    return x + y * resolution + z * resolution * resolution;
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
