import { StorageBufferAttribute, type ComputeNode, type Node } from 'three/webgpu';
import {
  Fn, If, clamp, float, floor, instanceIndex, int, ivec3, max, min, mix, storage, uint, vec3, vec4,
} from 'three/tsl';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';
import SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';

type Vec4Storage = { element(index: Node | number): Node<'vec4'> };
type FloatStorage = { element(index: Node | number): Node<'float'> };

/** Matched face divergence, pressure Laplacian and gradient for fluid projection. @internal */
export default class FluidPressureProjection {
  readonly attribute: StorageBufferAttribute;
  private readonly faces: Vec4Storage;
  private readonly faceCount: number;
  private initialized = false;
  private builds = new WeakMap<object, ComputeNode>();
  private centers = new WeakMap<object, ComputeNode>();
  private divergenceNode?: ComputeNode;
  private pressureNodes: ComputeNode[] = [];
  private projectNode?: ComputeNode;
  private clearFacesNode?: ComputeNode;
  private readonly beforeAttribute?: StorageBufferAttribute;
  private readonly beforeFaces?: Vec4Storage;
  private readonly beforeBuilds = new WeakMap<object, ComputeNode>();
  private clearWorkFacesNode?: ComputeNode;

  constructor(
    private readonly n: number,
    private readonly h: Node<'float'>,
    private readonly maxVelocity: Node<'float'>,
    private readonly solid: FloatStorage,
    private readonly pressure: FloatStorage,
    private readonly divergence: FloatStorage,
    private readonly closedMin: Node<'vec3'>,
    private readonly closedMax: Node<'vec3'>,
    private readonly grid?: SparseVolumeGrid,
    private readonly occupancy?: Vec4Storage,
    private readonly targetDivergence?: (index: Node<'uint'>) => Node<'float'>,
    private readonly workGrid?: SparseVolumeGrid,
  ) {
    this.faceCount = grid ? grid.capacity * (grid.brickSide + 1) ** 3 + 1 : (n + 1) ** 3;
    this.attribute = new StorageBufferAttribute(new Float32Array(this.faceCount * 4), 4);
    this.faces = storage(this.attribute, 'vec4', this.faceCount) as Vec4Storage;
    if (occupancy) {
      this.beforeAttribute = new StorageBufferAttribute(new Float32Array(this.faceCount * 4), 4);
      this.beforeFaces = storage(this.beforeAttribute, 'vec4', this.faceCount) as Vec4Storage;
    }
  }

  invalidate(): void { this.initialized = false; }

  dispose(): void { this.attribute.dispose(); this.beforeAttribute?.dispose(); }

  private coordinate(index: Node<'uint'>, side: number): Node<'ivec3'> {
    if (!this.grid) return ivec3(int(index.mod(side)), int(index.div(side).mod(side)), int(index.div(side * side)));
    if (side === this.n) return this.grid.coordinate(index);
    const b = this.grid.brickSide;
    const slot = uint(min(float(index.div((b + 1) ** 3)), this.grid.capacity - 1));
    const brick = uint(max(float(this.grid.slots.element(slot)), 1)).sub(1);
    return this.grid.unpack(brick, 2 ** this.grid.brickSubdivisions).mul(b)
      .add(this.grid.unpack(index.mod((b + 1) ** 3), b + 1)) as Node<'ivec3'>;
  }

  private face(coordinate: Node<'ivec3'>, axis: number, field = this.faces): Node<'float'> {
    const component = (['x', 'y', 'z'] as const)[axis];
    if (!this.grid) return field.element(uint(coordinate.x.add(coordinate.y.mul(this.n + 1))
      .add(coordinate.z.mul((this.n + 1) ** 2))))[component] as Node<'float'>;
    const b = this.grid.brickSide;
    const side = 2 ** this.grid.brickSubdivisions;
    const brick = ivec3(clamp(floor(vec3(coordinate).div(b)), vec3(0), vec3(side - 1)));
    const lowerBrick = ivec3(clamp(floor(vec3(coordinate.sub(this.axis(axis))).div(b)),
      vec3(0), vec3(side - 1)));
    const page = this.grid.pages.element(this.grid.flatten(brick, side));
    const owner = ivec3(page.greaterThan(0).select(brick, lowerBrick));
    const encoded = this.grid.pages.element(this.grid.flatten(owner, side));
    const local = coordinate.sub(owner.mul(b));
    const index = uint(max(float(encoded), 1)).sub(1).mul((b + 1) ** 3).add(this.grid.flatten(local, b + 1));
    const address = encoded.greaterThan(0).select(index, uint(this.faceCount - 1));
    return field.element(address)[component] as Node<'float'>;
  }

  private cell(coordinate: Node<'ivec3'>): Node<'uint'> {
    const clamped = ivec3(clamp(vec3(coordinate), vec3(0), vec3(this.n - 1)));
    return this.grid ? this.grid.index(clamped)
      : uint(clamped.x.add(clamped.y.mul(this.n)).add(clamped.z.mul(this.n * this.n)));
  }

  private compute(callback: (index: Node<'uint'>) => void, faces = false): ComputeNode {
    if (this.workGrid) return this.workGrid.computeDense(callback, faces);
    return this.grid ? this.grid.compute(callback, faces)
      : Fn(() => callback(instanceIndex))().compute(faces ? this.faceCount : this.n ** 3);
  }

  private inside(coordinate: Node<'ivec3'>): Node<'bool'> {
    return vec3(coordinate).greaterThanEqual(vec3(0)).all()
      .and(vec3(coordinate).lessThan(vec3(this.n)).all());
  }

  private occupied(coordinate: Node<'ivec3'>): Node<'bool'> {
    const wall = (['x', 'y', 'z'] as const).map((axis) => float(coordinate[axis]).lessThan(0)
      .and(this.closedMin[axis].greaterThan(0)).or(float(coordinate[axis]).greaterThanEqual(this.n)
        .and(this.closedMax[axis].greaterThan(0)))).reduce((a, b) => a.or(b));
    return wall.or(this.inside(coordinate).and(this.solid.element(this.cell(coordinate)).greaterThanEqual(0.5)));
  }

  private axis(axis: number): Node<'ivec3'> {
    return ivec3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  }

  private active(coordinate: Node<'ivec3'>): Node<'bool'> {
    if (!this.occupancy) return this.occupied(coordinate).not();
    return this.inside(coordinate).and(this.occupied(coordinate).not())
      .and(this.occupancy.element(this.cell(coordinate)).w.greaterThan(1.5));
  }

  private pressureValid(coordinate: Node<'ivec3'>): Node<'bool'> {
    return this.occupancy ? this.active(coordinate) : this.inside(coordinate);
  }

  private gradient(face: Node<'ivec3'>, axis: number): Node<'float'> {
    const lower = face.sub(this.axis(axis));
    const upper = face;
    const boundary = this.inside(lower).and(this.inside(upper)).not();
    const p0 = this.pressureValid(lower).select(this.pressure.element(this.cell(lower)), float(0));
    const p1 = this.pressureValid(upper).select(this.pressure.element(this.cell(upper)), float(0));
    return this.occupied(lower).or(this.occupied(upper)).select(
      float(0), p1.sub(p0).mul(boundary.select(2, 1)).div(this.h),
    );
  }

  private build(renderer: ParticleSpatialGridRenderer, input: Vec4Storage, before = false): void {
    const builds = before ? this.beforeBuilds : this.builds;
    const target = before ? this.beforeFaces! : this.faces;
    const node = builds.get(input) ?? this.compute(index => {
      const face = this.coordinate(index, this.n + 1);
      const components = (['x', 'y', 'z'] as const).map((component, axis) => {
        const lower = face.sub(this.axis(axis));
        const a = input.element(this.cell(lower))[component];
        const b = input.element(this.cell(face))[component];
        const validA = this.inside(lower).and(this.occupancy
          ? input.element(this.cell(lower)).w.greaterThan(0) : this.inside(lower));
        const validB = this.inside(face).and(this.occupancy
          ? input.element(this.cell(face)).w.greaterThan(0) : this.inside(face));
        const average = this.occupancy
          ? validA.and(validB).select(a.add(b).mul(0.5), validA.select(a, validB.select(b, float(0))))
          : this.inside(lower).and(this.inside(face)).select(a.add(b).mul(0.5), this.inside(lower).select(a, b));
        return this.occupied(lower).or(this.occupied(face)).select(float(0), average);
      });
      target.element(index).assign(vec4(components[0], components[1], components[2], 0));
    }, true);
    builds.set(input, node);
    renderer.compute(node);
    this.initialized = true;
  }

  initialize(renderer: ParticleSpatialGridRenderer, input: Vec4Storage): void {
    if (this.grid) {
      this.clearFacesNode ??= this.grid.compute(index => {
        this.faces.element(index).assign(vec4(0));
      }, true, true);
      renderer.compute(this.clearFacesNode);
    }
    if (!this.initialized) this.build(renderer, input);
  }

  /** Clear the previous work list before the owner rebuilds it for this step. */
  clearPreviousFaces(renderer: ParticleSpatialGridRenderer): void {
    if (this.workGrid) {
      this.clearWorkFacesNode ??= this.workGrid.computeDense(index => {
        this.faces.element(index).assign(vec4(0));
        this.beforeFaces!.element(index).assign(vec4(0));
      }, true);
      renderer.compute(this.clearWorkFacesNode);
    }
  }

  captureBefore(renderer: ParticleSpatialGridRenderer, input: Vec4Storage): void {
    this.build(renderer, input, true);
  }

  sample(position: Node<'vec3'>, before = false): Node<'vec3'> {
    const field = before ? this.beforeFaces! : this.faces;
    const values = (['x', 'y', 'z'] as const).map((_component, axis) => {
      const offset = vec3(axis === 0 ? 0 : 0.5, axis === 1 ? 0 : 0.5, axis === 2 ? 0 : 0.5);
      const coordinate = position.sub(offset);
      const base = floor(coordinate);
      const fraction = coordinate.sub(base);
      const limits = vec3(axis === 0 ? this.n : this.n - 1,
        axis === 1 ? this.n : this.n - 1, axis === 2 ? this.n : this.n - 1);
      const at = (x: number, y: number, z: number) => this.face(
        ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), limits)), axis, field,
      );
      if (this.occupancy) {
        const total = float(0).toVar(), weightSum = float(0).toVar();
        for (const z of [0, 1]) for (const y of [0, 1]) for (const x of [0, 1]) {
          const c = ivec3(clamp(base.add(vec3(x, y, z)), vec3(0), limits));
          const valid = this.active(c).or(this.active(c.sub(this.axis(axis))));
          const weight = (x ? fraction.x : float(1).sub(fraction.x))
            .mul(y ? fraction.y : float(1).sub(fraction.y))
            .mul(z ? fraction.z : float(1).sub(fraction.z)).mul(valid.select(1, 0));
          total.addAssign(this.face(c, axis, field).mul(weight));
          weightSum.addAssign(weight);
        }
        return total.div(weightSum.max(1e-6));
      }
      return mix(
        mix(mix(at(0, 0, 0), at(1, 0, 0), fraction.x), mix(at(0, 1, 0), at(1, 1, 0), fraction.x), fraction.y),
        mix(mix(at(0, 0, 1), at(1, 0, 1), fraction.x), mix(at(0, 1, 1), at(1, 1, 1), fraction.x), fraction.y),
        fraction.z,
      );
    });
    return vec3(values[0], values[1], values[2]);
  }

  solve(renderer: ParticleSpatialGridRenderer, input: Vec4Storage, output: Vec4Storage, iterations: number): void {
    this.build(renderer, input);
    this.divergenceNode ??= this.compute(index => {
      const c = this.coordinate(index, this.n);
      const divergence = this.face(c.add(ivec3(1, 0, 0)), 0).sub(this.face(c, 0))
        .add(this.face(c.add(ivec3(0, 1, 0)), 1).sub(this.face(c, 1)))
        .add(this.face(c.add(ivec3(0, 0, 1)), 2).sub(this.face(c, 2))).div(this.h);
      const target = this.targetDivergence ? this.targetDivergence(index) : float(0);
      this.divergence.element(index).assign(this.active(c).select(divergence.sub(target), float(0)));
      this.pressure.element(index).assign(0);
    });
    renderer.compute(this.divergenceNode);

    // Each color reads only the opposite color, with dispatch boundaries between
    // updates. Solid faces are Neumann; open domain faces have zero pressure at h/2.
    for (let parity = 0; parity < 2; parity += 1) {
      this.pressureNodes[parity] ??= this.compute(index => {
        const c = this.coordinate(index, this.n);
        If(c.x.add(c.y).add(c.z).mod(2).equal(parity).and(this.active(c)), () => {
          const sum = float(0).toVar();
          const diagonal = float(0).toVar();
          for (let axis = 0; axis < 3; axis += 1) {
            for (const sign of [-1, 1]) {
              const neighbor = c.add(this.axis(axis).mul(sign));
              const weight = this.occupied(neighbor).select(0, this.inside(neighbor).select(1, 2));
              diagonal.addAssign(weight);
              sum.addAssign(this.pressureValid(neighbor).select(
                this.pressure.element(this.cell(neighbor)).mul(weight), float(0),
              ));
            }
          }
          this.pressure.element(index).assign(sum.sub(
            this.divergence.element(index).mul(this.h.mul(this.h)),
          ).div(max(diagonal, float(1))));
        });
      });
    }
    for (let iteration = 0; iteration < Math.max(0, Math.floor(iterations)); iteration += 1) {
      renderer.compute(this.pressureNodes[0]);
      renderer.compute(this.pressureNodes[1]);
    }

    this.projectNode ??= this.compute(index => {
      const face = this.coordinate(index, this.n + 1);
      const gradient = vec3(this.gradient(face, 0), this.gradient(face, 1), this.gradient(face, 2));
      // Safety limits can leave residual divergence when active, as with the
      // center-velocity limit. They are not part of the pressure operator.
      this.faces.element(index).xyz.assign(clamp(
        this.faces.element(index).xyz.sub(gradient), this.maxVelocity.negate(), this.maxVelocity,
      ));
    }, true);
    renderer.compute(this.projectNode);

    const centerNode = this.centers.get(input) ?? this.compute(index => {
      const c = this.coordinate(index, this.n);
      const gradient = vec3(...[0, 1, 2].map(axis => this.gradient(c, axis)
        .add(this.gradient(c.add(this.axis(axis)), axis)).mul(0.5)) as [Node<'float'>, Node<'float'>, Node<'float'>]);
      const velocity = input.element(index).xyz.sub(gradient);
      const limited = velocity.mul(clamp(this.maxVelocity.div(max(velocity.length(), float(1e-6))), 0, 1));
      output.element(index).assign(this.occupied(c).select(vec4(0), vec4(limited,
        this.occupancy ? input.element(index).w : float(0))));
    });
    this.centers.set(input, centerNode);
    renderer.compute(centerNode);
  }
}
