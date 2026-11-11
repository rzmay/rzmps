import { triTable } from 'three/addons/objects/MarchingCubes.js';
import { StorageBufferAttribute, type Node } from 'three/webgpu';
import { If, Loop, array, atomicAdd, float, int, ivec3, mix, storage, uint, vec3, vec4 } from 'three/tsl';
import type { SurfaceExtractor } from './LiquidSurface';

// Three's classic table uses cyclic face corners; the sparse field uses x + 2*y + 4*z.
const cornerOrder = [0, 1, 3, 2, 4, 5, 7, 6];
const endpoints = [
  [0, 1],
  [1, 3],
  [3, 2],
  [2, 0],
  [4, 5],
  [5, 7],
  [7, 6],
  [6, 4],
  [0, 4],
  [1, 5],
  [3, 7],
  [2, 6],
];
const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);

// Reuse the lookup table across extractors; GPU output buffers belong to LiquidSurface.
const tableAttribute = new StorageBufferAttribute(triTable, 1);

export const buildMarchingCubes: SurfaceExtractor = options => {
  const { grid, field, positions, indices, counters, iso, maximumTriangles, minimum, cellSize } = options;
  const table = storage(tableAttribute, 'int', triTable.length);
  // Classify each active cube and interpolate its crossing edges.
  const node = grid.compute(index => {
    const coordinate = grid.coordinate(index);
    If(
      vec3(coordinate)
        .lessThan(vec3(grid.cellsPerAxis - 1))
        .all(),
      () => {
        const samples = corners.map(corner => field.element(grid.index(coordinate.add(ivec3(...corner)))).w);
        const mask = uint(0).toVar();
        cornerOrder.forEach((corner, bit) => {
          mask.addAssign(samples[corner].greaterThanEqual(iso).select(uint(1 << bit), uint(0)));
        });
        If(mask.notEqual(0).and(mask.notEqual(255)), () => {
          const edgePoints = array(
            endpoints.map(([a, b]) => {
              const difference = samples[b].sub(samples[a]);
              const t = difference
                .abs()
                .greaterThan(1e-12)
                .select(iso.sub(samples[a]).div(difference), float(0.5))
                .clamp(0, 1);
              return mix(vec3(...corners[a]), vec3(...corners[b]), t);
            }),
          );

          // Orient table triangles using the same outward scalar gradient as vertex shading.
          const gradient = [1, 2, 4].map(bit =>
            samples.reduce<Node<'float'>>(
              (sum, value, corner) => (corner & bit ? sum.sub(value) : sum.add(value)),
              float(0),
            ),
          );
          const outward = vec3(gradient[0], gradient[1], gradient[2]);

          // Reserve output atomically and count overflow without writing past the mesh budget.
          Loop(5, ({ i }) => {
            const entry = int(mask.mul(16)).add(i.mul(3));
            const edge = table.element(entry);
            If(edge.greaterThanEqual(0), () => {
              const triangle = atomicAdd(counters.element(0), uint(1)).toVar();
              If(triangle.lessThan(maximumTriangles), () => {
                const points = [edge, table.element(entry.add(1)), table.element(entry.add(2))].map(at =>
                  edgePoints.element(uint(at)).toVar(),
                );
                const reverse = points[1].sub(points[0]).cross(points[2].sub(points[0])).dot(outward).lessThan(0);
                [points[0], reverse.select(points[2], points[1]), reverse.select(points[1], points[2])].forEach(
                  (point, vertex) => {
                    const at = triangle.mul(3).add(vertex);
                    positions.element(at).assign(vec4(vec3(coordinate).add(point).mul(cellSize).add(minimum), 1));
                    indices.element(at).assign(at);
                  },
                );
                atomicAdd(counters.element(1), uint(3));
              });
            });
          });
        });
      },
    );
  });
  return { nodes: [node] };
};
