import { SurfaceVertexLayout } from '../../enums/SurfaceVertexLayout';
import type { Node } from 'three/webgpu';
import {
  If,
  atomicAdd,
  atomicLoad,
  atomicOr,
  atomicStore,
  clamp,
  float,
  ivec3,
  mix,
  uint,
  vec3,
  vec4,
} from 'three/tsl';
import type { SurfaceExtractor, SurfaceVectorStorage as Vec4Storage } from './LiquidSurface';

const corners = Array.from({ length: 8 }, (_, i) => [i & 1, (i >> 1) & 1, (i >> 2) & 1]);
const edges = corners.flatMap((_, i) => [1, 2, 4].filter(bit => !(i & bit)).map(bit => [i, i | bit]));

/** Shared dual-cell vertices with connected quads and optional topology-preserving mesh smoothing. */
export const buildSurfaceNets: SurfaceExtractor = Object.assign(
  (context: Parameters<SurfaceExtractor>[0]) => {
    const {
      grid,
      field,
      positions,
      indices,
      topology,
      counters,
      cellSize,
      minimum,
      maximumTriangles,
      vertexMap,
      maximumVertices,
      iso: isoLevel,
      smoothing,
      smoothingWeight,
    } = context;
    if (!vertexMap || maximumVertices === undefined) throw new Error('Surface nets require compact vertex storage.');
    const worldPoint = (coordinate: Node<'ivec3'>) => vec3(coordinate).mul(cellSize).add(minimum);

    // Create one dual vertex for every cell containing an iso crossing.
    const buildVertex = (index: Node<'uint'>): void => {
      const coordinate = grid.coordinate(index);
      const samples = corners.map(corner => field.element(grid.index(coordinate.add(ivec3(...corner)))));
      const position = vec3(0).toVar();
      const crossings = float(0).toVar();
      atomicStore(vertexMap.element(index), uint(0));
      atomicStore(topology.element(index), uint(0));
      atomicStore(topology.element(index.add(grid.cellCount)), uint(0));

      // Never read beyond the logical page table at the final grid plane.
      If(
        vec3(coordinate)
          .lessThan(vec3(grid.cellsPerAxis - 1))
          .all(),
        () => {
          for (const [a, b] of edges) {
            const first = samples[a],
              second = samples[b];
            If(first.w.greaterThanEqual(isoLevel).xor(second.w.greaterThanEqual(isoLevel)), () => {
              const t = isoLevel.sub(first.w).div(second.w.sub(first.w)).clamp(0, 1);
              position.addAssign(mix(vec3(...corners[a]), vec3(...corners[b]), t));
              crossings.addAssign(1);
            });
          }
          If(crossings.greaterThan(0), () => {
            const point = worldPoint(coordinate).add(position.div(crossings).mul(cellSize));
            const vertex = atomicAdd(counters.element(1), uint(1)).toVar();
            If(vertex.lessThan(maximumVertices), () => {
              atomicStore(vertexMap.element(index), vertex.add(1));
              positions.element(vertex).assign(vec4(point, 1));
            });
          });
        },
      );
    };

    // Stitch neighboring dual cells around each crossing primal edge.
    const buildFaces = (index: Node<'uint'>): void => {
      const c = grid.coordinate(index);
      for (let axis = 0; axis < 3; axis++) {
        const direction = [0, 0, 0];
        const u = [0, 0, 0],
          v = [0, 0, 0];
        direction[axis] = 1;
        u[(axis + 1) % 3] = 1;
        v[(axis + 2) % 3] = 1;
        const inside = field.element(index).w.greaterThanEqual(isoLevel);
        const other = field.element(grid.index(c.add(ivec3(...direction)))).w.greaterThanEqual(isoLevel);
        const valid = c[axis === 0 ? 'y' : axis === 1 ? 'z' : 'x']
          .greaterThan(0)
          .and(c[axis === 0 ? 'z' : axis === 1 ? 'x' : 'y'].greaterThan(0))
          .and(
            vec3(c)
              .lessThan(vec3(grid.cellsPerAxis - 1))
              .all(),
          );
        If(valid.and(inside.xor(other)), () => {
          const quad = [
            index,
            grid.index(c.sub(ivec3(...u))),
            grid.index(c.sub(ivec3(...u)).sub(ivec3(...v))),
            grid.index(c.sub(ivec3(...v))),
          ];
          const addresses = quad.map(at => atomicLoad(vertexMap.element(at)).toVar());
          const present = addresses.map(at => at.greaterThan(0)).reduce((a, b) => a.and(b));
          If(present, () => {
            const face = atomicAdd(counters.element(0), uint(2)).toVar();
            If(face.add(2).lessThanEqual(maximumTriangles), () => {
              const vertices = addresses.map(at => at.sub(1));
              const order = [vertices[0], inside.select(vertices[1], vertices[3]), vertices[2],
                vertices[0], vertices[2], inside.select(vertices[3], vertices[1])];
              order.forEach((at, i) => {
                indices.element(face.mul(3).add(i)).assign(at);
              });
              atomicOr(topology.element(index.add(grid.cellCount)), uint(1 << axis));
              const uAxis = (axis + 1) % 3,
                vAxis = (axis + 2) % 3;
              for (const [at, direction, sign] of [
                [0, uAxis, -1],
                [0, vAxis, -1],
                [1, uAxis, 1],
                [1, vAxis, -1],
                [2, vAxis, 1],
                [2, uAxis, 1],
                [3, uAxis, -1],
                [3, vAxis, 1],
              ]) {
                atomicOr(topology.element(quad[at]), uint(1 << (direction * 2 + (sign < 0 ? 1 : 0))));
              }
            });
          });
        });
      }
    };

    // Follow emitted topology rather than averaging arbitrary nearby vertices.
    const smoothVertex = (index: Node<'uint'>, source: Vec4Storage, target: Vec4Storage, reverse: boolean): void => {
      const address = atomicLoad(vertexMap.element(index)).toVar();
      If(address.greaterThan(0), () => {
        const vertex = address.sub(1);
        const current = source.element(vertex).toVar();
        target.element(vertex).assign(current);
        // Materialize before conditional neighbor reads so TSL cannot cache it inside only one branch.
        const coordinate = grid.coordinate(index).toVar();
        const mask = atomicLoad(topology.element(index)).toVar();
        const total = vec3(0).toVar();
        const count = float(0).toVar();
        for (let axis = 0; axis < 3; axis++)
          for (const sign of [1, -1]) {
            const offset = [0, 0, 0];
            offset[axis] = sign;
            const bit = 1 << (axis * 2 + (sign < 0 ? 1 : 0));
            If(mask.bitAnd(bit).notEqual(0), () => {
              const neighbor = atomicLoad(vertexMap.element(grid.index(coordinate.add(ivec3(...offset))))).sub(1);
              total.addAssign(source.element(neighbor).xyz);
              count.addAssign(1);
            });
          }
        If(count.greaterThan(0), () => {
          // Taubin's paired Laplacian steps attenuate ripples with much less shrinkage than repeated averaging.
          const weight = reverse
            ? smoothingWeight.negate().div(float(1).sub(smoothingWeight.mul(0.1)))
            : smoothingWeight;
          const position = current.xyz.add(total.div(count).sub(current.xyz).mul(weight));
          const lower = worldPoint(coordinate);
          target.element(vertex).assign(vec4(clamp(position, lower, lower.add(cellSize)), 1));
        });
      });
    };

    return {
      nodes: [grid.compute(buildVertex), grid.compute(buildFaces)],
      smoothingNodes: [
        grid.compute(index => smoothVertex(index, positions, smoothing, false)),
        grid.compute(index => smoothVertex(index, smoothing, positions, true)),
      ],
      triangleMultiple: 2,
    };
  },
  { vertexLayout: SurfaceVertexLayout.Compact },
);
