import type { Node } from 'three/webgpu';
import { Break, If, Loop, array, float, uint, uvec2, vec3 } from 'three/tsl';

// Both sides of a shared face use the same global-axis corner order.
const faces = [
  { corners: [0, 2, 6, 4], edges: [3, 11, 7, 8] },
  { corners: [1, 3, 7, 5], edges: [1, 10, 5, 9] },
  { corners: [0, 1, 5, 4], edges: [0, 9, 4, 8] },
  { corners: [2, 3, 7, 6], edges: [2, 10, 6, 11] },
  { corners: [0, 1, 3, 2], edges: [0, 1, 2, 3] },
  { corners: [4, 5, 7, 6], edges: [4, 5, 6, 7] },
];

/** Face deciders stitch crossing-edge contours; classic table cases without ambiguous faces stay unchanged. */
export function buildAsymptoticFaces(samples: Node<'float'>[], iso: Node<'float'>,
  points: { element(index: Node<'uint'>): Node<'vec3'> },
  emit: (points: Node<'vec3'>[]) => void, classic: () => void): void {
  const ambiguous = faces.map(face => {
    const signs = face.corners.map(c => samples[c].greaterThanEqual(iso));
    return signs[0].xor(signs[2]).not().and(signs[1].xor(signs[3]).not()).and(signs[0].xor(signs[1]));
  }).reduce((a, b) => a.or(b));
  If(ambiguous, () => {
    const links = array(Array.from({ length: 12 }, () => uvec2(255))).toVar() as unknown as {
      element(index: Node<'uint'> | number): Node<'uvec2'>;
    };
    const degrees = array(Array.from({ length: 12 }, () => uint(0))).toVar() as unknown as {
      element(index: Node<'uint'> | number): Node<'uint'>;
    };
    const connect = (a: Node<'uint'>, b: Node<'uint'>) => {
      If(degrees.element(a).equal(0), () => links.element(a).x.assign(b))
        .Else(() => links.element(a).y.assign(b));
      degrees.element(a).addAssign(1);
      If(degrees.element(b).equal(0), () => links.element(b).x.assign(a))
        .Else(() => links.element(b).y.assign(a));
      degrees.element(b).addAssign(1);
    };
    for (const face of faces) {
      const f = face.corners.map(c => samples[c].sub(iso));
      const crossings = face.edges.map((_, i) => f[i].greaterThanEqual(0).xor(f[(i + 1) % 4].greaterThanEqual(0)));
      const count = crossings.reduce<Node<'uint'>>(
        (sum, crossing) => sum.add(crossing.select(uint(1), uint(0))), uint(0),
      );
      If(count.equal(2), () => {
        const first = uint(255).toVar(), second = uint(255).toVar();
        crossings.forEach((crossing, i) => If(crossing, () => {
          If(first.equal(255), () => { first.assign(face.edges[i]); })
            .Else(() => { second.assign(face.edges[i]); });
        }));
        connect(first, second);
      }).ElseIf(count.equal(4), () => {
        // Bilinear saddle determinant, not the face-center average. Exact ties use the same
        // canonical orientation on both cells, making the choice independent of traversal order.
        const determinant = f[0].mul(f[2]).sub(f[1].mul(f[3]));
        If(determinant.greaterThanEqual(float(0)), () => {
          connect(uint(face.edges[0]), uint(face.edges[1]));
          connect(uint(face.edges[2]), uint(face.edges[3]));
        }).Else(() => {
          connect(uint(face.edges[0]), uint(face.edges[3]));
          connect(uint(face.edges[1]), uint(face.edges[2]));
        });
      });
    }
    const visited = uint(0).toVar();
    for (let start = 0; start < 12; start++) {
      If(degrees.element(start).equal(2).and(visited.bitAnd(1 << start).equal(0)), () => {
        const hub = vec3(0).toVar(), count = float(0).toVar();
        const previous = uint(255).toVar(), current = uint(start).toVar();
        // Interior hubs avoid placing fan diagonals on a shared ambiguous face,
        // where the adjacent cell could otherwise create overlapping/non-manifold triangles.
        Loop(12, () => {
          If(current.greaterThanEqual(12), () => Break());
          hub.addAssign(points.element(current)); count.addAssign(1);
          visited.bitOrAssign(uint(1).shiftLeft(current));
          const pair = links.element(current);
          const next = pair.x.equal(previous).select(pair.y, pair.x).toVar();
          If(next.equal(start).or(next.greaterThanEqual(12)), () => Break());
          previous.assign(current); current.assign(next);
        });
        hub.divAssign(count.max(1));
        previous.assign(255); current.assign(start);
        Loop(12, () => {
          If(current.greaterThanEqual(12), () => Break());
          const pair = links.element(current);
          const next = pair.x.equal(previous).select(pair.y, pair.x).toVar();
          If(next.greaterThanEqual(12), () => Break());
          emit([hub, points.element(current), points.element(next)]);
          If(next.equal(start), () => Break());
          previous.assign(current); current.assign(next);
        });
      });
    }
  }).Else(classic);
}
