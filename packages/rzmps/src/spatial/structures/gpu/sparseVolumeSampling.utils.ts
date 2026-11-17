import { Vector3 } from 'three';
import type { Node, StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, clamp, floor, int, ivec3, mix, storage, uint, uniform, vec3, vec4 } from 'three/tsl';
import type SparseVolumeGrid from './SparseVolumeGrid';

type Directory = { element(index: Node | number): Node<'uint'> };

/** Shared sparse address calculation. Layout and capacity can be runtime uniforms. */
export function sparseCellIndex(coordinate: Node<'ivec3'>, pages: Directory, dimensions: Node<'vec3'>,
  brickSide: Node<'float'>, cellCount: Node<'uint'>): Node<'uint'> {
  const inside = vec3(coordinate).greaterThanEqual(0).all().and(vec3(coordinate).lessThan(dimensions).all());
  const bricks = dimensions.div(brickSide);
  const brick = ivec3(clamp(floor(vec3(coordinate).div(brickSide)), vec3(0), bricks.sub(1)));
  const flatten = (c: Node<'ivec3'>, side: Node<'vec3'>) => uint(c.x
    .add(c.y.mul(int(side.x))).add(c.z.mul(int(side.x.mul(side.y)))));
  const page = pages.element(flatten(brick, bricks));
  const local = coordinate.sub(brick.mul(int(brickSide)));
  const address = page.greaterThan(uint(0)).select(page, uint(1)).sub(1)
    .mul(uint(brickSide.mul(brickSide).mul(brickSide)))
    .add(flatten(local, vec3(brickSide)));
  return inside.and(page.greaterThan(uint(0))).select(address, cellCount.sub(1)) as Node<'uint'>;
}

/** Render-only bindings to existing storage; no field allocation, migration or pressure-owner capture. */
export function createSparseFieldSampler(grid: SparseVolumeGrid, attribute: StorageBufferAttribute) {
  // Runtime-sized arrays allow capacity changes without specializing another fragment pipeline.
  const pages = storage(grid.pagesAttribute, 'uint', 0).toReadOnly();
  const field = storage(attribute, 'vec4', 0).toReadOnly();
  const dimensions = uniform(new Vector3());
  const minimum = uniform(new Vector3());
  const spacing = uniform(1);
  const brickSide = uniform(1);
  const cellCount = uniform(1, 'uint');
  const update = (source: SparseVolumeGrid, values: StorageBufferAttribute) => {
    pages.value = source.pagesAttribute;
    field.value = values;
    dimensions.value.copy(source.gridDimensions);
    minimum.value.copy(source.bounds.min);
    spacing.value = source.cellSize;
    brickSide.value = source.brickSide;
    cellCount.value = source.cellCount;
  };
  update(grid, attribute);

  return {
    update,
    sample(position: Node<'vec3'>): Node<'vec3'> {
      return Fn(() => {
        const coordinate = position.sub(minimum).div(spacing).sub(0.5).toVar();
        const base = floor(coordinate).toVar();
        const ratio = coordinate.sub(base).toVar();
        const interpolate = (at: (x: number, y: number, z: number) => Node<'vec3'>) => mix(
          mix(mix(at(0, 0, 0), at(1, 0, 0), ratio.x), mix(at(0, 1, 0), at(1, 1, 0), ratio.x), ratio.y),
          mix(mix(at(0, 0, 1), at(1, 0, 1), ratio.x), mix(at(0, 1, 1), at(1, 1, 1), ratio.x), ratio.y),
          ratio.z,
        );
        const value = vec3(0).toVar();
        const local = base.sub(floor(base.div(brickSide)).mul(brickSide));
        const interior = base.greaterThanEqual(0).all().and(base.add(1).lessThan(dimensions).all())
          .and(local.lessThan(brickSide.sub(1)).all());
        If(interior, () => {
          // Most samples touch one brick: look up its page once and offset the eight vector reads.
          const address = sparseCellIndex(ivec3(base), pages, dimensions, brickSide, cellCount).toVar();
          If(address.lessThan(cellCount.sub(1)), () => value.assign(interpolate((x, y, z) => field
            .element(address.add(uint(brickSide.mul(z).add(y).mul(brickSide).add(x)))).xyz)));
        }).Else(() => {
          // Cross-brick/edge samples retain exact trilinear reconstruction and canonical empty cells.
          value.assign(interpolate((x, y, z) => {
            const address = sparseCellIndex(ivec3(base.add(vec3(x, y, z))), pages, dimensions, brickSide, cellCount)
              .toVar();
            return address.lessThan(cellCount.sub(1)).select(field.element(address), vec4(0)).xyz;
          }));
        });
        return value;
      })();
    },
  };
}
