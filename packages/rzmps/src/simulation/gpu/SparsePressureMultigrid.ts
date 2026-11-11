import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import { If, clamp, float, floor, ivec3, mix, storage, vec3, vec4 } from 'three/tsl';
import SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';

type Coordinate = Node<'ivec3'>;
type Scalar = Node<'float'>;

/** Algebraic field adapter shared by fine and coarse sparse pressure levels. @internal */
export interface SparsePressureLevel {
  grid: SparseVolumeGrid;
  spacing: Scalar;
  active(c: Coordinate): Node<'bool'>;
  pressure(c: Coordinate): Scalar;
  residual(c: Coordinate): Scalar;
  updateResidual(renderer: ParticleSpatialGridRenderer): void;
  open(c: Coordinate, axis: number): Scalar;
  add(c: Coordinate, value: Scalar): void;
}

/** Sparse geometric V-cycle corrections; geometry enters only through face coefficients. @internal */
export default class SparsePressureMultigrid {
  private readonly levels: CoarsePressureLevel[] = [];

  constructor(fine: SparsePressureLevel, closedMin: Node<'vec3'>, closedMax: Node<'vec3'>) {
    let parent = fine;
    while (parent.grid.cellsPerAxis > 4) {
      const grid = parent.grid;
      const level = new CoarsePressureLevel(parent, closedMin, closedMax, {
        brickSubdivisions: grid.cellSubdivisions > 0 ? grid.brickSubdivisions : grid.brickSubdivisions - 1,
        cellSubdivisions: Math.max(0, grid.cellSubdivisions - 1),
      });
      this.levels.push(level);
      parent = level;
    }
  }

  correct(renderer: ParticleSpatialGridRenderer): void {
    const cycle = (index: number) => {
      const level = this.levels[index];
      if (!level) return;
      level.restrict(renderer);
      level.smooth(renderer, index === this.levels.length - 1 ? 12 : 2);
      if (index < this.levels.length - 1) {
        cycle(index + 1);
        level.smooth(renderer, 2);
      }
      level.prolong(renderer);
    };
    cycle(0);
  }

  get allocatedBytes(): number {
    return this.levels.reduce((sum, level) => sum + level.allocatedBytes, 0);
  }

  dispose(): void { this.levels.forEach(level => level.dispose()); }
}

class CoarsePressureLevel implements SparsePressureLevel {
  readonly grid: SparseVolumeGrid;
  readonly spacing: Scalar;
  private readonly valuesAttribute: StorageBufferAttribute;
  private readonly coefficientsAttribute: StorageBufferAttribute;
  private readonly values;
  private readonly coefficients;
  private readonly restrictNode: ComputeNode;
  private readonly residualNode: ComputeNode;
  private readonly prolongNode: ComputeNode;
  private readonly smoothNodes: ComputeNode[];

  constructor(
    private readonly fine: SparsePressureLevel,
    private readonly closedMin: Node<'vec3'>,
    private readonly closedMax: Node<'vec3'>,
    options: { brickSubdivisions: number; cellSubdivisions: number },
  ) {
    this.grid = new SparseVolumeGrid(options, fine.grid.capacity);
    this.spacing = fine.spacing.mul(2);
    this.valuesAttribute = new StorageBufferAttribute(new Float32Array(this.grid.cellCount * 4), 4);
    this.coefficientsAttribute = new StorageBufferAttribute(new Float32Array(this.grid.cellCount * 4), 4);
    // x: correction, y: restricted residual, z: active-cell flag.
    this.values = storage(this.valuesAttribute, 'vec4', this.grid.cellCount);
    this.coefficients = storage(this.coefficientsAttribute, 'vec4', this.grid.cellCount);
    this.restrictNode = this.grid.compute(index => {
      const c = this.grid.coordinate(index);
      const base = c.mul(2);
      const rhs = float(0).toVar();
      const active = float(0).toVar();
      for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
        const child = base.add(ivec3(x, y, z));
        If(fine.active(child), () => {
          rhs.addAssign(fine.residual(child).mul(0.125));
          active.assign(1);
        });
      }
      const faces = [0, 1, 2].map(axis => {
        const open = float(0).toVar();
        for (const u of [0, 1]) for (const v of [0, 1]) {
          const offset = axis === 0 ? ivec3(0, u, v) : axis === 1 ? ivec3(u, 0, v) : ivec3(u, v, 0);
          open.addAssign(fine.open(base.add(offset), axis).mul(0.25));
        }
        return open;
      });
      this.values.element(index).assign(vec4(0, rhs, active, 0));
      this.coefficients.element(index).assign(vec4(faces[0], faces[1], faces[2], 0));
    });
    this.smoothNodes = [0, 1].map(parity => this.grid.compute(index => {
      const c = this.grid.coordinate(index);
      If(c.x.add(c.y).add(c.z).mod(2).equal(parity).and(this.active(c)), () => {
        const { sum, diagonal } = this.stencil(c);
        this.values.element(index).x.assign(diagonal.greaterThan(1e-6).select(
          sum.sub(this.values.element(index).y.mul(this.spacing.pow(2))).div(diagonal.max(1e-6)), float(0),
        ));
      });
    }));
    this.residualNode = this.grid.compute(index => {
      const c = this.grid.coordinate(index);
      const { sum, diagonal } = this.stencil(c);
      const residual = this.values.element(index).y
        .sub(sum.sub(diagonal.mul(this.pressure(c))).div(this.spacing.pow(2)));
      this.values.element(index).w.assign(this.active(c).select(residual, float(0)));
    });
    this.prolongNode = fine.grid.compute(index => {
      const c = fine.grid.coordinate(index);
      If(fine.active(c), () => {
        const location = vec3(c).mul(0.5).sub(0.25);
        const base = floor(location);
        const fraction = location.sub(base);
        const at = (x: number, y: number, z: number) => {
          const coordinate = ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), vec3(this.grid.cellsPerAxis - 1)));
          return this.active(coordinate).select(this.pressure(coordinate), float(0));
        };
        const correction = mix(
          mix(mix(at(0, 0, 0), at(1, 0, 0), fraction.x), mix(at(0, 1, 0), at(1, 1, 0), fraction.x), fraction.y),
          mix(mix(at(0, 0, 1), at(1, 0, 1), fraction.x), mix(at(0, 1, 1), at(1, 1, 1), fraction.x), fraction.y),
          fraction.z,
        );
        fine.add(c, correction);
      });
    });
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
      .or(float(c[component]).greaterThanEqual(this.grid.cellsPerAxis).and(this.closedMax[component].greaterThan(0)));
    const allocated = this.inside(c).and(this.grid.active(this.index(c)));
    return wall.select(float(0), allocated.select(
      this.coefficients.element(this.index(c))[component], float(1),
    ));
  }

  add(c: Coordinate, value: Scalar): void { this.values.element(this.index(c)).x.addAssign(value); }

  private index(c: Coordinate): Node<'uint'> {
    return this.grid.index(ivec3(clamp(vec3(c), vec3(0), vec3(this.grid.cellsPerAxis - 1))));
  }

  private inside(c: Coordinate): Node<'bool'> {
    return vec3(c).greaterThanEqual(vec3(0)).all().and(vec3(c).lessThan(vec3(this.grid.cellsPerAxis)).all());
  }

  private stencil(c: Coordinate): { sum: Scalar; diagonal: Scalar } {
    const sum = float(0).toVar();
    const diagonal = float(0).toVar();
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const direction = ivec3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      const neighbor = c.add(direction);
      const weight = this.open(sign < 0 ? c : neighbor, axis).mul(this.inside(neighbor).select(1, 2));
      diagonal.addAssign(weight);
      sum.addAssign(this.active(neighbor).select(this.pressure(neighbor).mul(weight), float(0)));
    }
    return { sum, diagonal };
  }

  restrict(renderer: ParticleSpatialGridRenderer): void {
    this.fine.updateResidual(renderer);
    this.fine.grid.restrictOccupancyTo(renderer, this.grid);
    renderer.compute(this.restrictNode);
  }

  smooth(renderer: ParticleSpatialGridRenderer, count: number): void {
    for (let iteration = 0; iteration < count; iteration++) renderer.compute(this.smoothNodes);
  }

  prolong(renderer: ParticleSpatialGridRenderer): void { renderer.compute(this.prolongNode); }

  get allocatedBytes(): number {
    return this.valuesAttribute.array.byteLength + this.coefficientsAttribute.array.byteLength
      + this.grid.allocatedBytes;
  }

  dispose(): void {
    [this.restrictNode, this.residualNode, this.prolongNode, ...this.smoothNodes].forEach(node => node.dispose());
    this.valuesAttribute.dispose();
    this.coefficientsAttribute.dispose();
    this.grid.dispose();
  }
}
