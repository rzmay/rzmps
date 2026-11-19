import { Box3, Vector3 } from 'three';
import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { If, clamp, float, floor, ivec3, storage, uniform, vec3, vec4 } from 'three/tsl';
import SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';
import { destroyStorageAttribute } from '../../utils/gpu/storage.utils';

type Coordinate = Node<'ivec3'>;
type Scalar = Node<'float'>;

/** Attribute-only staging payload; temporary grid donors are private to each live level. @internal */
interface CoarsePressureCapacityStorage {
  readonly valuesAttribute: StorageBufferAttribute;
  readonly coefficientsAttribute: StorageBufferAttribute;
  readonly attributes: StorageBufferAttribute[];
  readonly sourceAttributes: readonly StorageBufferAttribute[];
}

/** @internal */
export interface SparsePressureMultigridCapacityStorage {
  readonly levels: CoarsePressureCapacityStorage[];
  readonly attributes: StorageBufferAttribute[];
}

/** Algebraic field adapter shared by fine and coarse sparse pressure levels. @internal */
export interface SparsePressureLevel {
  grid: SparseVolumeGrid;
  spacing: Scalar;
  /** Physical spacing per axis once a thin axis stops coarsening. */
  axisSpacing?: Node<'vec3'>;
  enabled?: Node<'bool'>;
  rebuildOperator?: Node<'bool'>;
  active(c: Coordinate): Node<'bool'>;
  pressure(c: Coordinate): Scalar;
  residual(c: Coordinate): Scalar;
  updateResidual(renderer: ParticleSpatialGridRenderer): void;
  open(c: Coordinate, axis: number): Scalar;
  add(c: Coordinate, value: Scalar): void;
}

/** Internal cycle controls used by the equal-accuracy diagnostic. @internal */
export interface SparsePressureCycleOptions {
  preSmooth: number;
  postSmooth: number;
  coarseIterations: number;
  trace?: (phase: string, level: SparsePressureLevel) => void;
}

/** Sparse geometric V-cycle corrections; geometry enters only through face coefficients. @internal */
export default class SparsePressureMultigrid {
  private readonly levels: CoarsePressureLevel[] = [];

  constructor(fine: SparsePressureLevel, closedMin: Node<'vec3'>, closedMax: Node<'vec3'>) {
    let parent = fine;
    // Reserve topology levels up front; plane growth must not discover/compile a new hierarchy.
    const maximumLevels = Math.max(1, Math.ceil(Math.log2(fine.grid.directoryCapacity * fine.grid.brickSide / 4)));
    for (let depth = 0; depth < maximumLevels; depth++) {
      const grid = parent.grid;
      const level = new CoarsePressureLevel(parent, closedMin, closedMax, {
        brickSubdivisions: grid.cellSubdivisions > 0 ? grid.brickSubdivisions : Math.max(0, grid.brickSubdivisions - 1),
        cellSubdivisions: Math.max(0, grid.cellSubdivisions - 1),
      });
      this.levels.push(level);
      parent = level;
    }
  }

  correct(renderer: ParticleSpatialGridRenderer, options: SparsePressureCycleOptions = {
    preSmooth: 2, postSmooth: 4, coarseIterations: 12,
  }, rebuild = true): void {
    const cycle = (index: number) => {
      const level = this.levels[index];
      if (!level || Math.max(...level.fineDimensions.toArray()) <= 2) return;
      if (level.fineDimensions.toArray().some(side => side > 1 && side % 2 !== 0)) return;
      if (rebuild) level.synchronizeLayout();
      level.restrict(renderer, rebuild);
      options.trace?.('restriction', level);
      // The active bottom level depends on current dimensions, not reserved hierarchy depth.
      const shape = level.grid.gridDimensions.toArray();
      // Do not replace an odd edge cell by a fictitious full-width coarse cell.
      const bottom = Math.max(...shape) <= 2 || shape.some(side => side > 1 && side % 2 !== 0)
        || index === this.levels.length - 1;
      level.smooth(renderer, bottom ? options.coarseIterations : options.preSmooth);
      options.trace?.(bottom ? 'coarseSolve' : 'preSmoothing', level);
      if (!bottom) {
        cycle(index + 1);
        options.trace?.('prolongation', level);
        level.smooth(renderer, options.postSmooth);
        options.trace?.('postSmoothing', level);
      }
      level.prolong(renderer);
    };
    cycle(0);
  }

  /** Compile currently inactive levels too, so a newly valid plane cannot introduce a cold level. */
  prepareAllLevels(renderer: ParticleSpatialGridRenderer): void {
    for (const level of this.levels) {
      level.synchronizeLayout();
      level.restrict(renderer); level.restrict(renderer, false);
      level.smooth(renderer, 1); level.prolong(renderer);
    }
  }

  /** Allocate backing storage only, without constructing any compute graph. */
  createCapacityStorage(capacity: number): SparsePressureMultigridCapacityStorage {
    const levels = this.levels.map(level => level.createCapacityStorage(capacity));
    return { levels, attributes: levels.flatMap(level => level.attributes) };
  }

  validateCapacityStorage(payload: SparsePressureMultigridCapacityStorage): void {
    if (payload.levels.length !== this.levels.length) throw new Error('Incompatible multigrid capacity storage.');
    this.levels.forEach((level, index) => level.validateCapacityStorage(payload.levels[index]));
  }

  adoptCapacityStorage(payload: SparsePressureMultigridCapacityStorage): StorageBufferAttribute[] {
    this.validateCapacityStorage(payload);
    return this.levels.flatMap((level, index) => level.adoptCapacityStorage(payload.levels[index]));
  }

  get allocatedBytes(): number {
    return this.levels.reduce((sum, level) => sum + level.allocatedBytes, 0);
  }

  dispose(renderer?: ParticleSpatialGridRenderer): void { this.levels.forEach(level => level.dispose(renderer)); }
}

class CoarsePressureLevel implements SparsePressureLevel {
  readonly grid: SparseVolumeGrid;
  readonly spacing: Scalar;
  readonly axisSpacing: Node<'vec3'>;
  readonly enabled?: Node<'bool'>;
  readonly rebuildOperator?: Node<'bool'>;
  private readonly ratio = uniform(new Vector3(2, 2, 2));
  private valuesAttribute: StorageBufferAttribute;
  private coefficientsAttribute: StorageBufferAttribute;
  private readonly capacityDonors = new WeakMap<CoarsePressureCapacityStorage, SparseVolumeGrid>();
  private readonly values;
  private readonly coefficients;
  private readonly restrictNode: ComputeNode;
  private readonly restrictRHSNode: ComputeNode;
  private readonly residualNode: ComputeNode;
  private readonly prolongNode: ComputeNode;
  private readonly smoothNodes: ComputeNode[];

  constructor(
    private readonly fine: SparsePressureLevel,
    private readonly closedMin: Node<'vec3'>,
    private readonly closedMax: Node<'vec3'>,
    options: { brickSubdivisions: number; cellSubdivisions: number },
  ) {
    const dimensions = fine.grid.gridDimensions.clone().divideScalar(2).ceil();
    const cellSize = fine.grid.cellSize * 2;
    const bounds = new Box3(fine.grid.bounds.min.clone(),
      fine.grid.bounds.min.clone().add(dimensions.clone().multiplyScalar(cellSize)));
    this.grid = new SparseVolumeGrid({ ...options, bounds },
      fine.grid.capacity, dimensions, fine.grid.directoryCapacity);
    this.spacing = fine.spacing.mul(2);
    this.axisSpacing = (fine.axisSpacing ?? vec3(fine.spacing)).mul(this.ratio);
    this.enabled = fine.enabled;
    this.rebuildOperator = fine.rebuildOperator;
    this.valuesAttribute = new StorageBufferAttribute(new Float32Array(this.grid.cellCount * 4), 4);
    this.coefficientsAttribute = new StorageBufferAttribute(new Float32Array(this.grid.cellCount * 4), 4);
    // x: correction, y: restricted residual, z: active-cell flag.
    this.values = storage(this.valuesAttribute, 'vec4', this.grid.cellCount);
    this.coefficients = storage(this.coefficientsAttribute, 'vec4', this.grid.cellCount);
    const compute = (grid: SparseVolumeGrid, callback: (index: Node<'uint'>) => void) => grid.compute(index => {
      if (this.enabled) If(this.enabled, () => callback(index));
      else callback(index);
    });
    const restriction = (index: Node<'uint'>, rebuild: boolean) => {
      const c = this.grid.coordinate(index);
      const base = ivec3(vec3(c).mul(this.ratio));
      const rhs = float(0).toVar();
      const active = float(0).toVar();
      for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
        const child = base.add(ivec3(x, y, z));
        const valid = vec3(x, y, z).lessThan(this.ratio).all()
          .and(vec3(child).lessThan(fine.grid.getDimensionsNode()).all());
        If(valid.and(fine.active(child)), () => {
          rhs.addAssign(fine.residual(child).div(this.ratio.x.mul(this.ratio.y).mul(this.ratio.z)));
          active.assign(1);
        });
      }
      // Pressure changes during a solve; topology and face coefficients do not.
      // Later V-cycles refresh only RHS/corrections, retaining the same operator and page assignments.
      this.values.element(index).assign(vec4(0, rhs, active, 0));
      if (!rebuild) return;
      const geometry = () => {
        const faces = [0, 1, 2].map(axis => {
          const open = float(0).toVar();
          for (const u of [0, 1]) for (const v of [0, 1]) {
            const offset = axis === 0 ? ivec3(0, u, v) : axis === 1 ? ivec3(u, 0, v) : ivec3(u, v, 0);
            const area = axis === 0 ? this.ratio.y.mul(this.ratio.z)
              : axis === 1 ? this.ratio.x.mul(this.ratio.z) : this.ratio.x.mul(this.ratio.y);
            If(vec3(offset).lessThan(this.ratio).all(), () => {
              open.addAssign(fine.open(base.add(offset), axis).div(area));
            });
          }
          return open;
        });
        this.coefficients.element(index).assign(vec4(faces[0], faces[1], faces[2], 0));
      };
      if (fine.rebuildOperator) If(fine.rebuildOperator, geometry);
      else geometry();
    };
    this.restrictNode = compute(this.grid, index => restriction(index, true));
    this.restrictRHSNode = compute(this.grid, index => restriction(index, false));
    this.smoothNodes = [0, 1].map(parity => compute(this.grid, index => {
      const c = this.grid.coordinate(index);
      If(c.x.add(c.y).add(c.z).mod(2).equal(parity).and(this.active(c)), () => {
        const { sum, diagonal } = this.stencil(c);
        this.values.element(index).x.assign(diagonal.greaterThan(1e-6).select(
          sum.sub(this.values.element(index).y).div(diagonal.max(1e-6)), float(0),
        ));
      });
    }));
    this.residualNode = compute(this.grid, index => {
      const c = this.grid.coordinate(index);
      const { sum, diagonal } = this.stencil(c);
      const residual = this.values.element(index).y
        .sub(sum.sub(diagonal.mul(this.pressure(c))));
      this.values.element(index).w.assign(this.active(c).select(residual, float(0)));
    });
    this.prolongNode = compute(fine.grid, index => {
      const c = fine.grid.coordinate(index);
      If(fine.active(c), () => {
        const location = vec3(c).add(0.5).div(this.ratio).sub(0.5);
        const base = floor(location);
        const fraction = location.sub(base);
        const correction = float(0).toVar();
        const normalization = float(0).toVar();
        for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
          const coordinate = ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), this.grid.getDimensionsNode().sub(1)));
          // Open domain faces use odd reflection (zero pressure at the face), closed faces even reflection.
          const raw = base.add(vec3(x, y, z));
          let sign: Scalar = float(1);
          for (const axis of ['x', 'y', 'z'] as const) {
            const reflect = raw[axis].lessThan(0).and(this.closedMin[axis].lessThanEqual(0))
              .or(raw[axis].greaterThanEqual(this.grid.getDimensionsNode()[axis])
                .and(this.closedMax[axis].lessThanEqual(0)));
            sign = sign.mul(reflect.select(float(-1), float(1)));
          }
          const weight = (x ? fraction.x : float(1).sub(fraction.x))
            .mul(y ? fraction.y : float(1).sub(fraction.y))
            .mul(z ? fraction.z : float(1).sub(fraction.z));
          const active = this.active(coordinate).toVar();
          // An inactive resident cell is solid, not zero-pressure air. Renormalize around it;
          // absent pages retain their Dirichlet contribution to the interpolation denominator.
          normalization.addAssign(active.or(this.grid.active(this.index(coordinate)).not()).select(weight, float(0)));
          correction.addAssign(active.select(this.pressure(coordinate).mul(sign).mul(weight), float(0)));
        }
        fine.add(c, correction.div(normalization.max(1e-6)));
      });
    });
  }

  get fineDimensions() { return this.fine.grid.gridDimensions; }

  private capacityAttributes(): StorageBufferAttribute[] {
    return [this.valuesAttribute, this.coefficientsAttribute, ...this.grid.capacityAttributes];
  }

  createCapacityStorage(capacity: number): CoarsePressureCapacityStorage {
    // A grid constructor allocates storage/uniform nodes only; compute graphs remain on the live grid.
    const donor = new SparseVolumeGrid({ brickSubdivisions: this.grid.brickSubdivisions,
      cellSubdivisions: this.grid.cellSubdivisions, bounds: this.grid.bounds },
    capacity, this.grid.gridDimensions, this.grid.directoryCapacity);
    // Indirect commands are retained on the live grid, never adopted from the allocation donor.
    donor.dispatchAttributes.forEach(attribute => attribute.dispose());
    const valuesAttribute = new StorageBufferAttribute(new Float32Array(donor.cellCount * 4), 4);
    const coefficientsAttribute = new StorageBufferAttribute(new Float32Array(donor.cellCount * 4), 4);
    const payload = { valuesAttribute, coefficientsAttribute,
      attributes: [valuesAttribute, coefficientsAttribute, ...donor.capacityAttributes],
      sourceAttributes: this.capacityAttributes() };
    this.capacityDonors.set(payload, donor);
    return payload;
  }

  validateCapacityStorage(payload: CoarsePressureCapacityStorage): void {
    const current = this.capacityAttributes(), donor = this.capacityDonors.get(payload);
    if (!donor || donor.capacity < this.grid.capacity || donor.directoryCapacity !== this.grid.directoryCapacity
      || current.length !== payload.sourceAttributes.length
      || current.some((attribute, index) => attribute !== payload.sourceAttributes[index])) {
      throw new Error('Stale or incompatible coarse pressure capacity storage.');
    }
  }

  adoptCapacityStorage(payload: CoarsePressureCapacityStorage): StorageBufferAttribute[] {
    this.validateCapacityStorage(payload);
    const retired = [this.valuesAttribute, this.coefficientsAttribute,
      ...this.grid.adoptCapacity(this.capacityDonors.get(payload)!)];
    this.valuesAttribute = payload.valuesAttribute;
    this.coefficientsAttribute = payload.coefficientsAttribute;
    this.values.value = this.valuesAttribute;
    this.coefficients.value = this.coefficientsAttribute;
    this.capacityDonors.delete(payload);
    // restrictOccupancyTo/restrict overwrite coarse occupancy, coefficients and corrections before use.
    return retired;
  }

  synchronizeLayout(): void {
    const fineDimensions = this.fine.grid.gridDimensions;
    this.ratio.value.set(fineDimensions.x > 1 ? 2 : 1, fineDimensions.y > 1 ? 2 : 1,
      fineDimensions.z > 1 ? 2 : 1);
    const dimensions = fineDimensions.clone().divide(this.ratio.value).ceil();
    const size = this.fine.grid.bounds.getSize(new Vector3());
    const bounds = new Box3(this.fine.grid.bounds.min.clone(), this.fine.grid.bounds.min.clone().add(size));
    this.grid.setLayoutMetadata(bounds, dimensions);
  }

  active(c: Coordinate): Node<'bool'> {
    return this.inside(c).and(this.grid.active(this.index(c))).and(this.values.element(this.index(c)).z.greaterThan(0));
  }

  pressure(c: Coordinate): Scalar { return this.values.element(this.index(c)).x; }

  residual(c: Coordinate): Scalar { return this.values.element(this.index(c)).w; }

  updateResidual(renderer: ParticleSpatialGridRenderer): void { renderer.compute(this.residualNode); }

  open(c: Coordinate, axis: number): Scalar {
    const component = (['x', 'y', 'z'] as const)[axis];
    const wall = float(c[component]).lessThanEqual(0).and(this.closedMin[component].greaterThan(0))
      .or(float(c[component]).greaterThanEqual(this.grid.getDimensionsNode()[component])
        .and(this.closedMax[component].greaterThan(0)));
    const allocated = this.inside(c).and(this.grid.active(this.index(c)));
    return wall.select(float(0), allocated.select(
      this.coefficients.element(this.index(c))[component], float(1),
    ));
  }

  add(c: Coordinate, value: Scalar): void { this.values.element(this.index(c)).x.addAssign(value); }

  private index(c: Coordinate): Node<'uint'> {
    return this.grid.index(ivec3(clamp(vec3(c), vec3(0), this.grid.getDimensionsNode().sub(1))));
  }

  private inside(c: Coordinate): Node<'bool'> {
    return vec3(c).greaterThanEqual(vec3(0)).all().and(vec3(c).lessThan(this.grid.getDimensionsNode()).all());
  }

  private stencil(c: Coordinate): { sum: Scalar; diagonal: Scalar } {
    const sum = float(0).toVar();
    const diagonal = float(0).toVar();
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const direction = ivec3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      const neighbor = c.add(direction);
      const component = (['x', 'y', 'z'] as const)[axis];
      const weight = this.open(sign < 0 ? c : neighbor, axis).mul(this.inside(neighbor).select(1, 2))
        .div(this.axisSpacing[component].pow(2));
      diagonal.addAssign(weight);
      sum.addAssign(this.active(neighbor).select(this.pressure(neighbor).mul(weight), float(0)));
    }
    return { sum, diagonal };
  }

  restrict(renderer: ParticleSpatialGridRenderer, rebuild = true): void {
    this.fine.updateResidual(renderer);
    if (rebuild) this.fine.grid.restrictOccupancyTo(renderer, this.grid, this.rebuildOperator);
    renderer.compute(rebuild ? this.restrictNode : this.restrictRHSNode);
  }

  smooth(renderer: ParticleSpatialGridRenderer, count: number): void {
    for (let iteration = 0; iteration < count; iteration++) renderer.compute(this.smoothNodes);
  }

  prolong(renderer: ParticleSpatialGridRenderer): void { renderer.compute(this.prolongNode); }

  get allocatedBytes(): number {
    return this.valuesAttribute.array.byteLength + this.coefficientsAttribute.array.byteLength
      + this.grid.allocatedBytes;
  }

  dispose(renderer?: ParticleSpatialGridRenderer): void {
    [this.restrictNode, this.restrictRHSNode, this.residualNode, this.prolongNode, ...this.smoothNodes]
      .forEach(node => node.dispose());
    destroyStorageAttribute(renderer, this.valuesAttribute);
    destroyStorageAttribute(renderer, this.coefficientsAttribute);
    this.valuesAttribute.dispose();
    this.coefficientsAttribute.dispose();
    this.grid.dispose(renderer);
  }
}
