import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, clamp, float, floor, instanceIndex, int, ivec3, max, min, mix, storage, uint, uniform, vec3, vec4,
} from 'three/tsl';
import Module, { type ModuleOptions } from '../Module';
import type ParticleSystem from '../ParticleSystem';
import type { GPUParticleLike, GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, {
  type ParticleSpatialGridOptions,
  type ParticleSpatialGridRenderer,
} from '../gpu/ParticleSpatialGrid';
import FluidCollider from '../spatial/FluidCollider';
import ThreeGPUCollisionBackend from '../collision/ThreeGPUCollisionBackend';
import { FluidBoundsPolicy } from '../enums/FluidBoundsPolicy';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type FloatStorage = { element(index: Node | number): Node<'float'> };
type UniformNode<T, TNode extends string> = Node<TNode> & { value: T };

export interface FluidSimulationOptions extends Partial<ModuleOptions> {
  bounds: THREE.Box3;
  spatialGridOptions: Partial<ParticleSpatialGridOptions>;
  pressureIterations: number;
  externalForce: THREE.Vector3;
  maxVelocity: number;
  boundsPadding: number;
  /** Maximum domain side length in simulation units. Infinity leaves growth unlimited.
   * Power-of-two grids round this limit down. Particle behavior is selected by boundsPolicy. */
  maxBounds: number;
  /** Behavior at the finite maxBounds cap, not intermediate adaptive edges. Defaults to Ballistic.
   * Contain retains a reached cap instead of shrinking away closed field walls. */
  boundsPolicy: FluidBoundsPolicy | `${FluidBoundsPolicy}`;
  /** Fluid-owned growth applied between updates. GPU hash auto-expansion is disabled. */
  automaticPadding: boolean;
  showGridHelper: boolean;
  /** Kept for older presets. The spatial grid depth takes precedence when supplied. */
  resolution: number;
}

abstract class FluidSimulation extends Module {
  bounds: THREE.Box3;
  readonly particleBounds = new THREE.Box3();
  automaticPaddingDistance = 0;
  resolution: number;
  cellSize: number;
  pressureIterations: number;
  externalForce: THREE.Vector3;
  maxVelocity: number;
  boundsPadding: number;
  maxBounds: number;
  boundsPolicy: FluidBoundsPolicy | `${FluidBoundsPolicy}`;
  automaticPadding: boolean;
  showGridHelper: boolean;
  readonly autoBounds: boolean;

  protected cellCount: number;
  protected readonly boundsMinNode: UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly cellSizeNode: UniformNode<number, 'float'>;
  protected readonly forceNode: UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly maxVelocityNode: UniformNode<number, 'float'>;
  protected readonly closedMinNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly closedMaxNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  private readonly capMinNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  private readonly capMaxNode = uniform(new THREE.Vector3()) as UniformNode<THREE.Vector3, 'vec3'>;
  private readonly capEnabledNode = uniform(0) as UniformNode<number, 'float'>;
  private readonly boundsPolicyNode = uniform(0) as UniformNode<number, 'float'>;
  private readonly capOrigin = new THREE.Vector3();
  private boundsReconcileKey = '';
  private boundsReconcileNode?: ComputeNode;
  protected velocityCurrentAttribute!: StorageBufferAttribute;
  protected velocityNextAttribute!: StorageBufferAttribute;
  protected pressureCurrentAttribute!: StorageBufferAttribute;
  protected pressureNextAttribute!: StorageBufferAttribute;
  protected divergenceAttribute!: StorageBufferAttribute;
  protected solidAttribute!: StorageBufferAttribute;
  protected velocityCurrent!: Vec4Storage;
  protected velocityNext!: Vec4Storage;
  protected pressureCurrent!: FloatStorage;
  protected pressureNext!: FloatStorage;
  protected divergence!: FloatStorage;
  protected solid!: FloatStorage;
  private lastBoundsRead = 0;
  private boundsReadPending = false;
  private boundsGeneration = 0;
  private pendingBounds?: { grid: ParticleSpatialGrid; bounds: THREE.Box3 };
  private compactBoundsReadCount = 0;
  private pressureNodes: ComputeNode[] = [];
  private divergenceNode?: ComputeNode;
  private projectionNodes = new WeakMap<object, ComputeNode>();
  private projectionIterations = -1;
  private solidNode?: ComputeNode;
  private solidCacheKey = '';
  private _boundsHelper?: THREE.Group;
  private _particleBoundsHelper?: THREE.Box3Helper;
  private _gridBoundsHelper?: THREE.Box3Helper;
  private _boundsHelperSystem?: ParticleSystem;
  protected readonly particleCollisionBackend = new ThreeGPUCollisionBackend();
  private readonly particleCollisionThicknessNode = uniform(0) as UniformNode<number, 'float'>;
  protected particleCollisionThicknessValue = 0;
  private particleCollisionState = false;
  private particleCollisionCacheKey = '';
  protected usesParticleColliderSweeps = false;
  constructor(options: Partial<FluidSimulationOptions> = {}) {
    const gridOptions = options.spatialGridOptions ?? {};
    const requestedDepth = Math.max(1, Math.ceil(Math.log2(options.resolution ?? 32)));
    const brickSubdivisions = gridOptions.brickSubdivisions ?? 2;
    const cellSubdivisions = gridOptions.cellSubdivisions
      ?? Math.max(0, requestedDepth - brickSubdivisions);
    const resolution = 2 ** (brickSubdivisions + cellSubdivisions);
    const bounds = options.bounds?.clone() ?? new THREE.Box3(
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, 1, 1),
    );
    const automaticPadding = options.automaticPadding ?? false;
    const maxBounds = options.maxBounds ?? Infinity;
    if (!(maxBounds > 0)) throw new RangeError('maxBounds must be positive.');
    const paddedBounds = FluidSimulation.limitBounds(ParticleSpatialGrid.normalizeBounds(
      FluidSimulation.padBounds(bounds, options.boundsPadding ?? 0.25),
      true, true, gridOptions.centeredAtOrigin ?? true,
    ), maxBounds);
    const spatialGrid = {
      ...gridOptions,
      bounds: paddedBounds,
      brickSubdivisions,
      cellSubdivisions,
      powerOfTwoBounds: true,
      cubicBounds: true,
      centeredAtOrigin: gridOptions.centeredAtOrigin ?? true,
      // The hash and Eulerian solver must use exactly the same bounds each frame.
      autoExpand: false,
      autoShrink: gridOptions.autoShrink ?? true,
      shrinkDelay: gridOptions.shrinkDelay ?? 600,
      expansionHysteresis: gridOptions.expansionHysteresis ?? 0.125,
    };
    super(Module.CPU_UNSUPPORTED, {
      ...options,
      priority: options.priority ?? Module.Priority.Permanent,
      modifyGPU: () => {},
      requireSpatialEffects: FluidCollider,
      useSpatialGrid: true,
      spatialGridOptions: spatialGrid,
    });

    this.bounds = ParticleSpatialGrid.normalizeBounds(
      paddedBounds,
      true,
      true,
      spatialGrid.centeredAtOrigin,
    );
    this.autoBounds = !options.bounds;
    this.resolution = resolution;
    this.cellCount = resolution ** 3;
    this.pressureIterations = Math.max(0, Math.floor(options.pressureIterations ?? 12));
    this.externalForce = options.externalForce?.clone() ?? new THREE.Vector3(0, -9.81, 0);
    this.maxVelocity = Math.max(0, options.maxVelocity ?? 20);
    this.boundsPadding = Math.max(0, options.boundsPadding ?? 0.25);
    this.maxBounds = maxBounds;
    this.boundsPolicy = options.boundsPolicy ?? FluidBoundsPolicy.Ballistic;
    this.bounds.getCenter(this.capOrigin);
    this.automaticPadding = automaticPadding;
    this.showGridHelper = options.showGridHelper ?? false;
    this.cellSize = this.bounds.getSize(new THREE.Vector3()).x / resolution;
    this.boundsMinNode = uniform(this.bounds.min.clone()) as UniformNode<THREE.Vector3, 'vec3'>;
    this.cellSizeNode = uniform(this.cellSize) as UniformNode<number, 'float'>;
    this.forceNode = uniform(this.externalForce) as UniformNode<THREE.Vector3, 'vec3'>;
    this.maxVelocityNode = uniform(this.maxVelocity) as UniformNode<number, 'float'>;
    this.syncBoundsPolicy();
    this.allocateGridFields();
  }

  public override prepare(particleSystem: ParticleSystem, dt: number): void {
    if (!particleSystem.isGPUProcessingActive) {
      throw new Error('Fluid simulations require GPU particle processing with a WebGPU renderer.');
    }
    super.prepare(particleSystem, dt);
    const grid = this.getParticleSpatialGrid(particleSystem);
    if (grid) this.synchronizeGridBounds(grid);
    this.syncBoundsPolicy();
    this.updateParticleCollisionBackend();
    this.updateBoundsHelper(particleSystem);
    this.forceNode.value.copy(this.externalForce);
    this.maxVelocityNode.value = this.maxVelocity;
  }

  private syncBoundsPolicy(): void {
    const index = Object.values(FluidBoundsPolicy).indexOf(this.boundsPolicy as FluidBoundsPolicy);
    if (index < 0) throw new RangeError('Unknown fluid boundsPolicy.');
    this.boundsPolicyNode.value = index;
    const finite = Number.isFinite(this.maxBounds);
    if (!(this.maxBounds > 0)) throw new RangeError('maxBounds must be positive.');
    this.capEnabledNode.value = finite ? 1 : 0;
    const half = finite ? 2 ** Math.floor(Math.log2(this.maxBounds)) * 0.5 : 1;
    this.capMinNode.value.copy(this.capOrigin).addScalar(-half);
    this.capMaxNode.value.copy(this.capOrigin).addScalar(half);
    const closed = finite && this.boundsPolicy === FluidBoundsPolicy.Contain;
    for (const axis of ['x', 'y', 'z'] as const) {
      this.closedMinNode.value[axis] = closed && this.bounds.min[axis] <= this.capMinNode.value[axis] + 1e-6 ? 1 : 0;
      this.closedMaxNode.value[axis] = closed && this.bounds.max[axis] >= this.capMaxNode.value[axis] - 1e-6 ? 1 : 0;
    }
  }

  protected isInsideCap(position: Node<'vec3'>): Node<'bool'> {
    return this.capEnabledNode.lessThan(0.5).or(position.greaterThanEqual(this.capMinNode).all()
      .and(position.lessThan(this.capMaxNode).all()));
  }

  public override finalizeGPU(particle: GPUParticleLike): void {
    If(this.capEnabledNode.greaterThan(0.5), () => {
      If(this.boundsPolicyNode.equal(1).and(this.isInsideCap(particle.position).not()), () => {
        particle.alive.assign(uint(0));
      });
      If(this.boundsPolicyNode.equal(2), () => {
        const half = this.capMaxNode.sub(this.capMinNode).x.mul(0.5);
        const epsilon = min(float(1e-5), half.mul(0.001));
        const radius = min(max(particle.scale.x.abs(), max(particle.scale.y.abs(), particle.scale.z.abs()))
          .mul(0.5), max(half.sub(epsilon), float(0)));
        const lower = this.capMinNode.add(radius).add(epsilon);
        const upper = this.capMaxNode.sub(radius).sub(epsilon);
        for (const axis of ['x', 'y', 'z'] as const) {
          const travel = particle.velocity[axis].mul(particle.speed);
          const outward = particle.position[axis].lessThan(lower[axis]).and(travel.lessThan(0))
            .or(particle.position[axis].greaterThan(upper[axis]).and(travel.greaterThan(0)));
          particle.velocity[axis].assign(outward.select(float(0), particle.velocity[axis]));
        }
        particle.position.assign(clamp(particle.position, lower, upper));
      });
    });
  }

  public override computeGPU(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
    grid?: ParticleSpatialGrid,
  ): void {
    if (!grid || !Number.isFinite(this.maxBounds) || this.boundsPolicy === FluidBoundsPolicy.Ballistic) return;
    const tagMask = context.system.getGPUFilterTagMask(this.tags);
    const key = [context.buffers.version, context.eventWriter?.version, context.eventWriter?.capacity,
      context.buffers.count, this.version, tagMask].join('|');
    if (key !== this.boundsReconcileKey) {
      this.boundsReconcileKey = key;
      this.boundsReconcileNode = Fn(() => {
        const particle = context.buffers.storage.createParticle(undefined, true);
        const selected = particle.alive.notEqual(uint(0)).and(tagMask === undefined
          ? uint(1).equal(1) : particle.tagMask.bitAnd(uint(tagMask)).notEqual(uint(0)));
        If(selected, () => {
          const reconcile = () => {
            this.finalizeGPU(particle);
            If(particle.alive.equal(uint(0)), () => { context.eventWriter?.emitDeath(particle); });
            context.buffers.storage.storeParticle(particle);
          };
          if (this.conditionGPU) If(this.conditionGPU(particle, context.deltaTimeNode, context, grid), reconcile);
          else reconcile();
        });
      })().compute(context.buffers.count);
    }
    renderer.compute(this.boundsReconcileNode!);
    grid.rebuild(renderer, context.buffers, {});
  }

  protected isClosedNeighbor(coordinate: Node<'ivec3'>): Node<'bool'> {
    return (['x', 'y', 'z'] as const).map((axis) => float(coordinate[axis]).lessThan(0)
      .and(this.closedMinNode[axis].greaterThan(0)).or(float(coordinate[axis]).greaterThanEqual(this.resolution)
        .and(this.closedMaxNode[axis].greaterThan(0)))).reduce((a, b) => a.or(b));
  }

  protected cellIndex(coordinate: Node<'ivec3'>): Node<'uint'> {
    return uint(coordinate.x.add(coordinate.y.mul(this.resolution))
      .add(coordinate.z.mul(this.resolution * this.resolution)));
  }

  protected computeCells(callback: (index: Node<'uint'>) => void): ComputeNode {
    return Fn(() => callback(instanceIndex))().compute(this.cellCount);
  }

  protected resizeGridFields(count: number): void {
    this.disposeGridFields();
    this.cellCount = count;
    this.allocateGridFields();
    this.resetGridNodes();
  }

  protected cellCoordinate(index: Node<'uint'>): Node<'ivec3'> {
    return ivec3(
      int(index.mod(this.resolution)),
      int(index.div(this.resolution).mod(this.resolution)),
      int(index.div(this.resolution * this.resolution)),
    );
  }

  protected cellCenter(coordinate: Node<'ivec3'>): Node<'vec3'> {
    return vec3(coordinate).add(0.5).mul(this.cellSizeNode).add(this.boundsMinNode);
  }

  protected worldToCell(position: Node<'vec3'>): Node<'ivec3'> {
    return ivec3(clamp(
      floor(position.sub(this.boundsMinNode).div(this.cellSizeNode)),
      vec3(0),
      vec3(this.resolution - 1),
    ));
  }

  protected sampleVelocity(position: Node<'vec3'>, field: Vec4Storage = this.velocityCurrent): Node<'vec3'> {
    return this.sampleField(position, field).xyz as Node<'vec3'>;
  }

  protected sampleField(
    position: Node<'vec3'>,
    field: Vec4Storage,
    occupancyOnly = false,
  ): Node<'vec4'> {
    const gridPosition = vec3(position.sub(this.boundsMinNode).div(this.cellSizeNode).sub(0.5));
    const base = floor(gridPosition);
    const ratio = clamp(gridPosition.sub(base), vec3(0), vec3(1));
    const sample = (x: number, y: number, z: number) => {
      const value = field.element(this.cellIndex(ivec3(clamp(
        base.add(vec3(x, y, z)), vec3(0), vec3(this.resolution - 1),
      ))));
      return occupancyOnly ? vec4(value.xyz, value.w.greaterThan(0).select(1, 0)) : value;
    };
    const lower = mix(
      mix(sample(0, 0, 0), sample(1, 0, 0), ratio.x),
      mix(sample(0, 1, 0), sample(1, 1, 0), ratio.x),
      ratio.y,
    );
    const upper = mix(
      mix(sample(0, 0, 1), sample(1, 0, 1), ratio.x),
      mix(sample(0, 1, 1), sample(1, 1, 1), ratio.x),
      ratio.y,
    );
    return mix(lower, upper, ratio.z) as Node<'vec4'>;
  }

  protected clampVelocity(velocity: Node<'vec3'>): Node<'vec3'> {
    const magnitude = max(velocity.length(), float(1e-6));
    return velocity.mul(clamp(this.maxVelocityNode.div(magnitude), 0, 1)) as Node<'vec3'>;
  }

  protected get hasParticleColliderGeometry(): boolean {
    return this.particleCollisionBackend.hasGeometry;
  }

  protected get particleCollisionThickness(): Node<'float'> {
    return this.particleCollisionThicknessNode;
  }

  protected queryParticleCollider(
    start: Node<'vec3'>,
    end: Node<'vec3'>,
    radius: Node<'float'>,
  ): Node {
    return this.particleCollisionBackend.queryCapsule(start, end, radius);
  }

  protected onParticleColliderGeometryChanged(): void {}

  protected ensureGridResolution(
    renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid,
  ): void {
    if (grid.cellsPerAxis === this.resolution) return;
    this.disposeGridFields();
    this.resolution = grid.cellsPerAxis;
    this.cellCount = this.resolution ** 3;
    this.cellSize = this.bounds.getSize(new THREE.Vector3()).x / this.resolution;
    this.cellSizeNode.value = this.cellSize;
    this.allocateGridFields();
    this.resetGridNodes();
    this.onGridResolutionChanged(renderer);
  }

  protected onGridResolutionChanged(renderer: ParticleSpatialGridRenderer): void {
    void renderer;
  }

  private allocateGridFields(): void {
    this.velocityCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.velocityNextAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.pressureCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.pressureNextAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.divergenceAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.solidAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.velocityCurrent = storage(this.velocityCurrentAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.velocityNext = storage(this.velocityNextAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.pressureCurrent = storage(this.pressureCurrentAttribute, 'float', this.cellCount) as FloatStorage;
    this.pressureNext = storage(this.pressureNextAttribute, 'float', this.cellCount) as FloatStorage;
    this.divergence = storage(this.divergenceAttribute, 'float', this.cellCount) as FloatStorage;
    this.solid = storage(this.solidAttribute, 'float', this.cellCount) as FloatStorage;
  }

  private resetGridNodes(): void {
    this.pressureNodes = [];
    this.divergenceNode = undefined;
    this.projectionNodes = new WeakMap();
    this.solidNode = undefined;
    this.solidCacheKey = '';
  }

  private disposeGridFields(): void {
    [
      this.velocityCurrentAttribute,
      this.velocityNextAttribute,
      this.pressureCurrentAttribute,
      this.pressureNextAttribute,
      this.divergenceAttribute,
      this.solidAttribute,
    ].forEach((attribute) => attribute?.dispose());
  }

  protected computeSolidField(
    context: GPUParticleUpdateContext,
    renderer: ParticleSpatialGridRenderer,
  ): void {
    const colliders = this.spatialEffects.filter((effect): effect is FluidCollider => (
      effect instanceof FluidCollider && effect.visible && effect.gridOccupancy
    ));
    colliders.forEach((collider) => collider.syncGPUTransform(context.system));
    const cacheKey = colliders
      .map((collider) => `${collider.uuid}:${collider.version}`)
      .join('|');
    if (cacheKey !== this.solidCacheKey) {
      this.solidCacheKey = cacheKey;
      this.solidNode = undefined;
    }

    const solidNode = this.solidNode ?? this.computeCells(index => {
      const center = this.cellCenter(this.cellCoordinate(index));
      const occupied = this.capEnabledNode.greaterThan(0.5).and(this.boundsPolicyNode.equal(2))
        .and(this.isInsideCap(center).not()).select(float(1), float(0)).toVar('fluidSolidCell');
      colliders.forEach((collider) => {
        occupied.assign(max(occupied, collider.testPositionGPU(center, context)));
      });
      this.solid.element(index).assign(occupied.greaterThan(0).select(1, 0));
    });
    this.solidNode = solidNode;
    renderer.compute(solidNode);
  }

  protected isSolid(index: Node | number = instanceIndex): Node<'bool'> {
    return this.solid.element(index).greaterThanEqual(0.5);
  }

  protected targetDivergence(index: Node<'uint'>): Node<'float'> {
    void index;
    return float(0);
  }

  protected pressureCellActive(field: Vec4Storage, index: Node<'uint'>): Node<'bool'> {
    return field.element(index).w.greaterThan(0);
  }

  protected solveProjection(
    renderer: ParticleSpatialGridRenderer,
    input: Vec4Storage,
    output: Vec4Storage,
    useOccupancy = false,
    solid?: FloatStorage,
  ): void {
    const iterations = Math.max(0, Math.floor(this.pressureIterations));
    if (iterations !== this.projectionIterations) {
      this.projectionIterations = iterations;
      this.projectionNodes = new WeakMap();
    }
    const divergence = this.divergenceNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const fluidCell = solid
        ? solid.element(instanceIndex).lessThan(0.5)
        : float(1).greaterThan(0);
      const active = (useOccupancy
        ? this.pressureCellActive(input, instanceIndex)
        : float(1).greaterThan(0)).and(fluidCell);
      const left = this.velocityAt(input, coordinate, -1, 0, 0, useOccupancy, solid).x;
      const right = this.velocityAt(input, coordinate, 1, 0, 0, useOccupancy, solid).x;
      const down = this.velocityAt(input, coordinate, 0, -1, 0, useOccupancy, solid).y;
      const up = this.velocityAt(input, coordinate, 0, 1, 0, useOccupancy, solid).y;
      const back = this.velocityAt(input, coordinate, 0, 0, -1, useOccupancy, solid).z;
      const front = this.velocityAt(input, coordinate, 0, 0, 1, useOccupancy, solid).z;
      this.divergence.element(instanceIndex).assign(
        active.select(
          right.sub(left).add(up.sub(down)).add(front.sub(back)).mul(0.5).div(this.cellSizeNode)
            .sub(this.targetDivergence(instanceIndex)),
          float(0),
        ),
      );
      this.pressureCurrent.element(instanceIndex).assign(0);
    })().compute(this.cellCount);
    this.divergenceNode = divergence;
    renderer.compute(divergence);

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const source = iteration % 2 === 0 ? this.pressureCurrent : this.pressureNext;
      const target = iteration % 2 === 0 ? this.pressureNext : this.pressureCurrent;
      const node = this.pressureNodes[iteration] ?? Fn(() => {
        const coordinate = this.cellCoordinate(instanceIndex);
        const fluidCell = solid
          ? solid.element(instanceIndex).lessThan(0.5)
          : float(1).greaterThan(0);
        const active = (useOccupancy
          ? this.pressureCellActive(input, instanceIndex)
          : float(1).greaterThan(0)).and(fluidCell);
        const sum = this.pressureAt(source, coordinate, -1, 0, 0, useOccupancy ? input : undefined, solid)
          .add(this.pressureAt(source, coordinate, 1, 0, 0, useOccupancy ? input : undefined, solid))
          .add(this.pressureAt(source, coordinate, 0, -1, 0, useOccupancy ? input : undefined, solid))
          .add(this.pressureAt(source, coordinate, 0, 1, 0, useOccupancy ? input : undefined, solid))
          .add(this.pressureAt(source, coordinate, 0, 0, -1, useOccupancy ? input : undefined, solid))
          .add(this.pressureAt(source, coordinate, 0, 0, 1, useOccupancy ? input : undefined, solid));
        target.element(instanceIndex).assign(
          active.select(
            sum.sub(this.divergence.element(instanceIndex).mul(this.cellSizeNode.mul(this.cellSizeNode))).div(6),
            float(0),
          ),
        );
      })().compute(this.cellCount);
      this.pressureNodes[iteration] = node;
      renderer.compute(node);
    }

    const pressure = iterations % 2 === 0 ? this.pressureCurrent : this.pressureNext;
    const project = this.projectionNodes.get(input) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const source = vec3(input.element(instanceIndex).xyz);
      const fluidCell = solid
        ? solid.element(instanceIndex).lessThan(0.5)
        : float(1).greaterThan(0);
      const active = (useOccupancy
        ? input.element(instanceIndex).w.greaterThan(0)
        : float(1).greaterThan(0)).and(fluidCell);
      const gradient = vec3(
        this.pressureAt(pressure, coordinate, 1, 0, 0, useOccupancy ? input : undefined, solid).sub(
          this.pressureAt(pressure, coordinate, -1, 0, 0, useOccupancy ? input : undefined, solid),
        ),
        this.pressureAt(pressure, coordinate, 0, 1, 0, useOccupancy ? input : undefined, solid).sub(
          this.pressureAt(pressure, coordinate, 0, -1, 0, useOccupancy ? input : undefined, solid),
        ),
        this.pressureAt(pressure, coordinate, 0, 0, 1, useOccupancy ? input : undefined, solid).sub(
          this.pressureAt(pressure, coordinate, 0, 0, -1, useOccupancy ? input : undefined, solid),
        ),
      ).mul(0.5).div(this.cellSizeNode);
      output.element(instanceIndex).assign(vec4(
        active.select(this.clampVelocity(source.sub(gradient)), vec3(0)),
        useOccupancy ? input.element(instanceIndex).w : float(0),
      ));
    })().compute(this.cellCount);
    this.projectionNodes.set(input, project);
    renderer.compute(project);
  }

  private velocityAt(
    field: Vec4Storage,
    coordinate: Node<'ivec3'>,
    x: number,
    y: number,
    z: number,
    useOccupancy = false,
    solid?: FloatStorage,
  ): Node<'vec3'> {
    const neighbor = coordinate.add(ivec3(x, y, z));
    const inside = vec3(neighbor).greaterThanEqual(vec3(0)).all()
      .and(vec3(neighbor).lessThan(vec3(this.resolution)).all());
    const neighborValue = field.element(this.cellIndex(ivec3(clamp(
      vec3(neighbor), vec3(0), vec3(this.resolution - 1),
    ))));
    const solidNeighbor = (solid ? inside.and(solid.element(this.cellIndex(ivec3(clamp(
      vec3(neighbor), vec3(0), vec3(this.resolution - 1),
    )))).greaterThanEqual(0.5)) : inside.and(false)).or(this.isClosedNeighbor(neighbor));
    const center = field.element(this.cellIndex(coordinate)).xyz;
    const valid = useOccupancy ? inside.and(neighborValue.w.greaterThan(0)) : inside;
    // Reflect the normal component at solid faces so divergence includes wall
    // inflow and pressure can support gravity in a filled container.
    const reflected = center.mul(vec3(x === 0 ? 1 : -1, y === 0 ? 1 : -1, z === 0 ? 1 : -1));
    return solidNeighbor.select(reflected, valid.select(neighborValue.xyz, center)) as Node<'vec3'>;
  }

  private pressureAt(
    field: FloatStorage,
    coordinate: Node<'ivec3'>,
    x: number,
    y: number,
    z: number,
    occupancy?: Vec4Storage,
    solid?: FloatStorage,
  ): Node<'float'> {
    const neighbor = coordinate.add(ivec3(x, y, z));
    const inside = vec3(neighbor).greaterThanEqual(vec3(0)).all()
      .and(vec3(neighbor).lessThan(vec3(this.resolution)).all());
    const clamped = ivec3(clamp(vec3(neighbor), vec3(0), vec3(this.resolution - 1)));
    const index = this.cellIndex(clamped);
    const solidNeighbor = (solid ? inside.and(solid.element(index).greaterThanEqual(0.5)) : inside.not())
      .or(this.isClosedNeighbor(neighbor));
    const valid = (occupancy ? inside.and(this.pressureCellActive(occupancy, index)) : inside)
      .and(solidNeighbor.not());
    const boundaryValue = solidNeighbor
      .select(field.element(this.cellIndex(coordinate)), float(0));
    return valid.select(field.element(index), boundaryValue) as Node<'float'>;
  }

  private synchronizeGridBounds(grid: ParticleSpatialGrid): void {
    if (grid.autoExpand || !grid.cubicBounds || !grid.powerOfTwoBounds) {
      grid.setOptions({ autoExpand: false, cubicBounds: true, powerOfTwoBounds: true });
    }
    const requested = this.pendingBounds?.grid === grid ? this.pendingBounds.bounds : this.bounds;
    this.pendingBounds = undefined;
    const bounds = FluidSimulation.limitBounds(ParticleSpatialGrid.normalizeBounds(
      requested, true, true, grid.centeredAtOrigin,
    ), this.maxBounds);
    if (!bounds.equals(grid.bounds)) grid.setBounds(bounds);
    if (bounds.equals(this.bounds)) return;
    const previous = this.bounds.clone();
    this.bounds.copy(bounds);
    this.cellSize = bounds.getSize(new THREE.Vector3()).x / this.resolution;
    this.boundsMinNode.value.copy(bounds.min);
    this.cellSizeNode.value = this.cellSize;
    this.boundsGeneration += 1;
    this.boundsReadPending = false;
    this.onBoundsChanged(previous);
  }

  protected refreshBounds(grid: ParticleSpatialGrid, renderer: ParticleSpatialGridRenderer): void {
    if (this.boundsReadPending || performance.now() - this.lastBoundsRead < 500) return;
    this.boundsReadPending = true;
    this.lastBoundsRead = performance.now();
    const generation = this.boundsGeneration;
    const currentBounds = this.bounds.clone();
    const particleMetrics = grid.readParticleMetrics(renderer);
    void Promise.all([
      particleMetrics,
      particleMetrics.then((metrics) => this.readAutomaticPadding(
        renderer,
        grid,
        metrics.maxParticleSpeed,
      )),
    ]).then(([metrics, automaticPadding]) => {
      if (generation !== this.boundsGeneration || this.spatialGrid !== grid) return;
      const { bounds: particleBounds } = metrics;
      this.particleBounds.copy(particleBounds);
      this.automaticPaddingDistance = automaticPadding;
      const automaticBounds = FluidSimulation.padBoundsByDistance(
        particleBounds,
        Math.max(automaticPadding, this.manualPaddingDistance(particleBounds)),
      );
      const targetBounds = particleBounds.isEmpty()
        ? currentBounds
        : ParticleSpatialGrid.normalizeBounds(
          automaticBounds.clone().expandByScalar(
            Math.max(automaticPadding * 0.25, this.cellSize * 2),
          ),
          grid.powerOfTwoBounds,
          grid.cubicBounds,
          grid.centeredAtOrigin,
        );
      let requestedBounds = currentBounds;

      if (this.automaticPadding && !particleBounds.isEmpty()) {
        if (!currentBounds.containsBox(automaticBounds)) {
          this.compactBoundsReadCount = 0;
          requestedBounds = targetBounds;
        } else {
          const currentSide = currentBounds.getSize(new THREE.Vector3()).x;
          const targetSide = targetBounds.getSize(new THREE.Vector3()).x;
          const compact = targetSide < currentSide * 0.75;
          this.compactBoundsReadCount = compact ? this.compactBoundsReadCount + 1 : 0;
          const readsBeforeShrink = Math.max(1, Math.ceil(grid.shrinkDelay / 30));
          const closedCap = this.boundsPolicy === FluidBoundsPolicy.Contain && Number.isFinite(this.maxBounds)
            && currentSide >= 2 ** Math.floor(Math.log2(this.maxBounds));
          if (grid.autoShrink && !closedCap && this.compactBoundsReadCount >= readsBeforeShrink) {
            this.compactBoundsReadCount = 0;
            requestedBounds = targetBounds;
          }
        }
      } else {
        this.compactBoundsReadCount = 0;
      }
      const bounds = FluidSimulation.limitBounds(ParticleSpatialGrid.normalizeBounds(
        requestedBounds,
        grid.powerOfTwoBounds,
        grid.cubicBounds,
        grid.centeredAtOrigin,
      ), this.maxBounds);
      if (!this.bounds.equals(bounds)) this.pendingBounds = { grid, bounds };
    }).catch(() => {}).finally(() => {
      if (generation === this.boundsGeneration) this.boundsReadPending = false;
    });
  }

  protected readAutomaticPadding(
    renderer: ParticleSpatialGridRenderer,
    grid: ParticleSpatialGrid,
    maxParticleSpeed: number,
  ): Promise<number> {
    void renderer;
    void grid;
    void maxParticleSpeed;
    return Promise.resolve(0);
  }

  protected onBoundsChanged(previous: THREE.Box3): void {
    void previous;
  }

  private static limitBounds(bounds: THREE.Box3, limit: number): THREE.Box3 {
    if (!Number.isFinite(limit)) return bounds;
    if (!(limit > 0)) throw new RangeError('maxBounds must be positive.');
    const side = Math.min(bounds.getSize(new THREE.Vector3()).x, 2 ** Math.floor(Math.log2(limit)));
    const center = bounds.getCenter(new THREE.Vector3());
    return new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3().setScalar(side));
  }

  public override cleanup(): void {
    this.boundsGeneration += 1;
    this.pendingBounds = undefined;
    this.boundsReadPending = false;
    this.lastBoundsRead = 0;
    this.boundsReconcileNode = undefined;
    this.boundsReconcileKey = '';
    super.cleanup();
    this.particleCollisionBackend.destroy();
    if (this._boundsHelper) {
      this._boundsHelperSystem?.removeRendererObject(this._boundsHelper);
      [this._particleBoundsHelper, this._gridBoundsHelper].forEach((helper) => {
        helper?.geometry.dispose();
        (helper?.material as THREE.Material | undefined)?.dispose();
      });
      this._boundsHelper = undefined;
      this._particleBoundsHelper = undefined;
      this._gridBoundsHelper = undefined;
      this._boundsHelperSystem = undefined;
    }
    this.disposeGridFields();
  }

  private updateParticleCollisionBackend(): void {
    if (!this.usesParticleColliderSweeps) return;
    const colliders = this.spatialEffects.filter((effect): effect is FluidCollider => (
      effect instanceof FluidCollider
      && effect.visible
      && effect.particleCollision
      && Boolean(effect.geometry)
    ));
    this.particleCollisionThicknessValue = colliders.reduce(
      (maximum, collider) => Math.max(maximum, collider.surfaceThickness),
      0,
    );
    this.particleCollisionThicknessNode.value = this.particleCollisionThicknessValue;
    const cacheKey = colliders
      .map((collider) => `${collider.uuid}:${collider.version}`)
      .join('|');
    this.particleCollisionBackend.staticObjects = colliders.map((collider) => (
      collider.getCollisionObject()
    ));
    this.particleCollisionBackend.update();
    const nextState = this.particleCollisionBackend.hasGeometry;
    if (nextState !== this.particleCollisionState || cacheKey !== this.particleCollisionCacheKey) {
      this.particleCollisionState = nextState;
      this.particleCollisionCacheKey = cacheKey;
      this.onParticleColliderGeometryChanged();
      this.needsUpdate = true;
    }
  }

  static padBounds(bounds: THREE.Box3, ratio: number): THREE.Box3 {
    const size = bounds.getSize(new THREE.Vector3());
    const side = Math.max(size.x, size.y, size.z, 1);
    return new THREE.Box3().setFromCenterAndSize(
      bounds.getCenter(new THREE.Vector3()),
      new THREE.Vector3(1, 1, 1).multiplyScalar(side * (1 + 2 * ratio)),
    );
  }

  static padBoundsByDistance(bounds: THREE.Box3, distance: number): THREE.Box3 {
    return bounds.clone().expandByScalar(Math.max(0, distance));
  }

  private manualPaddingDistance(bounds: THREE.Box3): number {
    const size = bounds.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z, 1) * this.boundsPadding;
  }

  private updateBoundsHelper(particleSystem: ParticleSystem): void {
    if (!this._boundsHelper) {
      this._particleBoundsHelper = new THREE.Box3Helper(this.particleBounds, 0xffb347);
      this._particleBoundsHelper.name = 'Fluid Particle Bounds';
      this._gridBoundsHelper = new THREE.Box3Helper(this.bounds, 0x36d7e8);
      this._gridBoundsHelper.name = 'Fluid Grid Bounds';
      [this._particleBoundsHelper, this._gridBoundsHelper].forEach((helper) => {
        const material = helper.material as THREE.LineBasicMaterial;
        material.depthTest = false;
        material.depthWrite = false;
        material.opacity = 0.9;
        material.transparent = true;
        helper.renderOrder = 1000;
        helper.frustumCulled = false;
      });
      this._boundsHelper = new THREE.Group();
      this._boundsHelper.name = 'Fluid Bounds Helper';
      this._boundsHelper.add(this._gridBoundsHelper, this._particleBoundsHelper);
      this._boundsHelperSystem = particleSystem;
      particleSystem.addRendererObject(this._boundsHelper);
    }
    this._boundsHelper.visible = this.showGridHelper;
    this._particleBoundsHelper!.visible = !this.particleBounds.isEmpty();
  }
}

export default FluidSimulation;
