import * as THREE from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, clamp, float, floor, instanceIndex, int, ivec3, max, storage, uint, uniform, vec3, vec4 } from 'three/tsl';
import Module, { type ModuleOptions } from '../Module';
import type ParticleSystem from '../ParticleSystem';
import type { GPUParticleUpdateContext } from '../gpu/Particle';
import ParticleSpatialGrid, { type ParticleSpatialGridOptions, type ParticleSpatialGridRenderer } from '../gpu/ParticleSpatialGrid';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type FloatStorage = { element(index: Node | number): Node<'float'> };
type UniformNode<T, TNode extends string> = Node<TNode> & { value: T };

export interface FluidSimulationOptions extends Partial<ModuleOptions> {
  bounds: THREE.Box3;
  spatialGrid: ParticleSpatialGrid | Partial<ParticleSpatialGridOptions>;
  pressureIterations: number;
  externalForce: THREE.Vector3;
  maxVelocity: number;
  boundsPadding: number;
  /** Kept for older presets. The spatial grid depth takes precedence when supplied. */
  resolution: number;
}

abstract class FluidSimulation extends Module {
  bounds: THREE.Box3;
  resolution: number;
  cellSize: number;
  pressureIterations: number;
  externalForce: THREE.Vector3;
  maxVelocity: number;
  boundsPadding: number;
  readonly autoBounds: boolean;
  readonly spatialGridConfiguration: Partial<ParticleSpatialGridOptions>;

  protected readonly cellCount: number;
  protected readonly boundsMinNode: UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly cellSizeNode: UniformNode<number, 'float'>;
  protected readonly forceNode: UniformNode<THREE.Vector3, 'vec3'>;
  protected readonly maxVelocityNode: UniformNode<number, 'float'>;
  protected readonly velocityCurrentAttribute: StorageBufferAttribute;
  protected readonly velocityNextAttribute: StorageBufferAttribute;
  protected readonly pressureCurrentAttribute: StorageBufferAttribute;
  protected readonly pressureNextAttribute: StorageBufferAttribute;
  protected readonly divergenceAttribute: StorageBufferAttribute;
  protected readonly velocityCurrent: Vec4Storage;
  protected readonly velocityNext: Vec4Storage;
  protected readonly pressureCurrent: FloatStorage;
  protected readonly pressureNext: FloatStorage;
  protected readonly divergence: FloatStorage;
  private lastBoundsRead = 0;
  private boundsReadPending = false;
  private readonly pressureNodes: ComputeNode[] = [];
  private divergenceNode?: ComputeNode;
  private projectionNodes = new WeakMap<object, ComputeNode>();

  constructor(options: Partial<FluidSimulationOptions> = {}) {
    const gridOptions = options.spatialGrid instanceof ParticleSpatialGrid
      ? options.spatialGrid
      : options.spatialGrid ?? {};
    const requestedDepth = Math.max(1, Math.ceil(Math.log2(options.resolution ?? 32)));
    const brickSubdivisions = gridOptions.brickSubdivisions ?? 2;
    const cellSubdivisions = gridOptions.cellSubdivisions
      ?? Math.max(0, requestedDepth - brickSubdivisions);
    const resolution = 2 ** (brickSubdivisions + cellSubdivisions);
    const bounds = options.bounds?.clone() ?? new THREE.Box3(
      new THREE.Vector3(-1, -1, -1),
      new THREE.Vector3(1, 1, 1),
    );
    const paddedBounds = FluidSimulation.padBounds(bounds, options.boundsPadding ?? 0.25);
    const spatialGrid = options.spatialGrid instanceof ParticleSpatialGrid
      ? options.spatialGrid
      : {
        ...gridOptions,
        bounds: paddedBounds,
        brickSubdivisions,
        cellSubdivisions,
        powerOfTwoBounds: true,
        cubicBounds: true,
        autoExpand: true,
        autoShrink: true,
        shrinkDelay: 600,
        expansionHysteresis: gridOptions.expansionHysteresis ?? 0.25,
      };
    super(Module.CPU_UNSUPPORTED, {
      ...options,
      priority: options.priority ?? Module.Priority.Permanent,
      modifyGPU: () => {},
      useSpatialGrid: true,
      spatialGrid,
    });

    this.bounds = options.spatialGrid instanceof ParticleSpatialGrid
      ? options.spatialGrid.bounds.clone()
      : ParticleSpatialGrid.normalizeBounds(paddedBounds, true, true);
    this.autoBounds = !options.bounds;
    this.spatialGridConfiguration = {
      brickSubdivisions,
      cellSubdivisions,
      powerOfTwoBounds: true,
      cubicBounds: true,
      autoExpand: true,
      autoShrink: true,
      shrinkDelay: 600,
      expansionHysteresis: gridOptions.expansionHysteresis ?? 0.25,
    };
    this.resolution = resolution;
    this.cellCount = resolution ** 3;
    this.pressureIterations = Math.max(0, Math.floor(options.pressureIterations ?? 12));
    this.externalForce = options.externalForce?.clone() ?? new THREE.Vector3(0, -9.81, 0);
    this.maxVelocity = Math.max(0, options.maxVelocity ?? 20);
    this.boundsPadding = Math.max(0, options.boundsPadding ?? 0.25);
    this.cellSize = this.bounds.getSize(new THREE.Vector3()).x / resolution;
    this.boundsMinNode = uniform(this.bounds.min.clone()) as UniformNode<THREE.Vector3, 'vec3'>;
    this.cellSizeNode = uniform(this.cellSize) as UniformNode<number, 'float'>;
    this.forceNode = uniform(this.externalForce) as UniformNode<THREE.Vector3, 'vec3'>;
    this.maxVelocityNode = uniform(this.maxVelocity) as UniformNode<number, 'float'>;
    this.velocityCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.velocityNextAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount * 4), 4);
    this.pressureCurrentAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.pressureNextAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.divergenceAttribute = new StorageBufferAttribute(new Float32Array(this.cellCount), 1);
    this.velocityCurrent = storage(this.velocityCurrentAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.velocityNext = storage(this.velocityNextAttribute, 'vec4', this.cellCount) as Vec4Storage;
    this.pressureCurrent = storage(this.pressureCurrentAttribute, 'float', this.cellCount) as FloatStorage;
    this.pressureNext = storage(this.pressureNextAttribute, 'float', this.cellCount) as FloatStorage;
    this.divergence = storage(this.divergenceAttribute, 'float', this.cellCount) as FloatStorage;
  }

  public override prepare(particleSystem: ParticleSystem, dt: number): void {
    if (!particleSystem.isGPUProcessingActive) {
      throw new Error('Fluid simulations require GPU particle processing with a WebGPU renderer.');
    }
    super.prepare(particleSystem, dt);
    this.forceNode.value.copy(this.externalForce);
    this.maxVelocityNode.value = this.maxVelocity;
  }

  protected cellIndex(coordinate: Node<'ivec3'>): Node<'uint'> {
    return uint(coordinate.x.add(coordinate.y.mul(this.resolution))
      .add(coordinate.z.mul(this.resolution * this.resolution)));
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
    return field.element(this.cellIndex(this.worldToCell(position))).xyz as Node<'vec3'>;
  }

  protected clampVelocity(velocity: Node<'vec3'>): Node<'vec3'> {
    const magnitude = max(velocity.length(), float(1e-6));
    return velocity.mul(clamp(this.maxVelocityNode.div(magnitude), 0, 1)) as Node<'vec3'>;
  }

  protected solveProjection(renderer: ParticleSpatialGridRenderer, input: Vec4Storage, output: Vec4Storage): void {
    const divergence = this.divergenceNode ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const left = this.velocityAt(input, coordinate, -1, 0, 0).x;
      const right = this.velocityAt(input, coordinate, 1, 0, 0).x;
      const down = this.velocityAt(input, coordinate, 0, -1, 0).y;
      const up = this.velocityAt(input, coordinate, 0, 1, 0).y;
      const back = this.velocityAt(input, coordinate, 0, 0, -1).z;
      const front = this.velocityAt(input, coordinate, 0, 0, 1).z;
      this.divergence.element(instanceIndex).assign(
        right.sub(left).add(up.sub(down)).add(front.sub(back)).mul(0.5).div(this.cellSizeNode),
      );
      this.pressureCurrent.element(instanceIndex).assign(0);
    })().compute(this.cellCount);
    this.divergenceNode = divergence;
    renderer.compute(divergence);

    for (let iteration = 0; iteration < this.pressureIterations; iteration += 1) {
      const source = iteration % 2 === 0 ? this.pressureCurrent : this.pressureNext;
      const target = iteration % 2 === 0 ? this.pressureNext : this.pressureCurrent;
      const node = this.pressureNodes[iteration] ?? Fn(() => {
        const coordinate = this.cellCoordinate(instanceIndex);
        const sum = this.pressureAt(source, coordinate, -1, 0, 0)
          .add(this.pressureAt(source, coordinate, 1, 0, 0))
          .add(this.pressureAt(source, coordinate, 0, -1, 0))
          .add(this.pressureAt(source, coordinate, 0, 1, 0))
          .add(this.pressureAt(source, coordinate, 0, 0, -1))
          .add(this.pressureAt(source, coordinate, 0, 0, 1));
        target.element(instanceIndex).assign(
          sum.sub(this.divergence.element(instanceIndex).mul(this.cellSizeNode.mul(this.cellSizeNode))).div(6),
        );
      })().compute(this.cellCount);
      this.pressureNodes[iteration] = node;
      renderer.compute(node);
    }

    const pressure = this.pressureIterations % 2 === 0 ? this.pressureCurrent : this.pressureNext;
    const project = this.projectionNodes.get(input) ?? Fn(() => {
      const coordinate = this.cellCoordinate(instanceIndex);
      const source = vec3(input.element(instanceIndex).xyz);
      const gradient = vec3(
        this.pressureAt(pressure, coordinate, 1, 0, 0).sub(this.pressureAt(pressure, coordinate, -1, 0, 0)),
        this.pressureAt(pressure, coordinate, 0, 1, 0).sub(this.pressureAt(pressure, coordinate, 0, -1, 0)),
        this.pressureAt(pressure, coordinate, 0, 0, 1).sub(this.pressureAt(pressure, coordinate, 0, 0, -1)),
      ).mul(0.5).div(this.cellSizeNode);
      output.element(instanceIndex).assign(vec4(this.clampVelocity(source.sub(gradient)), 0));
    })().compute(this.cellCount);
    this.projectionNodes.set(input, project);
    renderer.compute(project);
  }

  private velocityAt(field: Vec4Storage, coordinate: Node<'ivec3'>, x: number, y: number, z: number): Node<'vec3'> {
    const neighbor = coordinate.add(ivec3(x, y, z));
    const inside = vec3(neighbor).greaterThanEqual(vec3(0)).all()
      .and(vec3(neighbor).lessThan(vec3(this.resolution)).all());
    return inside.select(field.element(this.cellIndex(ivec3(clamp(
      vec3(neighbor), vec3(0), vec3(this.resolution - 1),
    )))).xyz, vec3(0)) as Node<'vec3'>;
  }

  private pressureAt(field: FloatStorage, coordinate: Node<'ivec3'>, x: number, y: number, z: number): Node<'float'> {
    const neighbor = coordinate.add(ivec3(x, y, z));
    const inside = vec3(neighbor).greaterThanEqual(vec3(0)).all()
      .and(vec3(neighbor).lessThan(vec3(this.resolution)).all());
    const clamped = ivec3(clamp(vec3(neighbor), vec3(0), vec3(this.resolution - 1)));
    return inside.select(field.element(this.cellIndex(clamped)), float(0)) as Node<'float'>;
  }

  protected refreshBounds(grid: ParticleSpatialGrid, renderer: ParticleSpatialGridRenderer): void {
    if (this.boundsReadPending || performance.now() - this.lastBoundsRead < 500) return;
    this.boundsReadPending = true;
    this.lastBoundsRead = performance.now();
    void grid.readBounds(renderer).then((bounds) => {
      if (this.bounds.equals(bounds)) return;
      const previous = this.bounds.clone();
      this.bounds.copy(bounds);
      this.cellSize = this.bounds.getSize(new THREE.Vector3()).x / this.resolution;
      this.boundsMinNode.value.copy(this.bounds.min);
      this.cellSizeNode.value = this.cellSize;
      this.onBoundsChanged(previous);
    }).catch(() => {}).finally(() => { this.boundsReadPending = false; });
  }

  protected onBoundsChanged(_previous: THREE.Box3): void {}

  public override cleanup(): void {
    super.cleanup();
    [
      this.velocityCurrentAttribute,
      this.velocityNextAttribute,
      this.pressureCurrentAttribute,
      this.pressureNextAttribute,
      this.divergenceAttribute,
    ].forEach((attribute) => attribute.dispose());
  }

  static padBounds(bounds: THREE.Box3, ratio: number): THREE.Box3 {
    const size = bounds.getSize(new THREE.Vector3());
    const side = Math.max(size.x, size.y, size.z, 1);
    return new THREE.Box3().setFromCenterAndSize(
      bounds.getCenter(new THREE.Vector3()),
      new THREE.Vector3(1, 1, 1).multiplyScalar(side * (1 + 2 * ratio)),
    );
  }
}

export default FluidSimulation;
