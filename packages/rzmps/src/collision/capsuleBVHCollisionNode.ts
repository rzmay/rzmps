import { Node, StructNode, StructTypeNode } from 'three/webgpu';
import { mat4, nodeObject } from 'three/tsl';
// three-mesh-bvh 0.9.x omits declarations for these focused WebGPU exports.
// @ts-expect-error incomplete upstream WebGPU declarations
import { bvhNodeBoundsStruct } from 'three-mesh-bvh/src/webgpu/tsl/structs.js';
// @ts-expect-error incomplete upstream WebGPU declarations
import { closestPointToTriangle } from 'three-mesh-bvh/src/webgpu/tsl/fns.js';
// @ts-expect-error incomplete upstream WebGPU declarations
import { wgslTagFn } from 'three-mesh-bvh/src/webgpu/nodes/WGSLTagFnNode.js';

export interface BVHComputeDataLike {
  storage: Record<string, any>;
  getShapecastFn(options: Record<string, unknown>): (...args: any[]) => Node;
}

export const capsuleQueryStruct = new StructTypeNode({
  start: 'vec3f',
  end: 'vec3f',
  radius: 'float',
}, 'RZMPSCapsuleQuery');
export const CapsuleQuery = (start: Node, end: Node, radius: Node) => new StructNode(
  capsuleQueryStruct,
  { start, end, radius } as unknown as Node[],
);

export const capsuleHitStruct = new StructTypeNode({
  found: 'bool',
  point: 'vec3f',
  capsulePoint: 'vec3f',
  normal: 'vec3f',
  distanceSq: 'float',
  side: 'float',
  objectIndex: 'uint',
}, 'RZMPSCapsuleHit');

class CapsuleQueryCallNode extends Node {
  constructor(
    private readonly queryFunction: Node,
    private readonly capsule: Node,
  ) {
    super('vec3');
  }

  generateNodeType(builder: Parameters<Node['build']>[0]): string {
    return capsuleHitStruct.getNodeType(builder);
  }

  getMemberType(builder: Parameters<Node['build']>[0], name: string): string {
    return capsuleHitStruct.getMemberType(builder, name);
  }

  generate(builder: Parameters<Node['build']>[0]): string {
    const functionName = this.queryFunction.build(builder, 'property');
    return `${functionName}( ${this.capsule.build(builder)} )`;
  }
}

/** Creates a world-space capsule shapecast over three-mesh-bvh's packed TLAS/BLAS. */
export default function capsuleBVHCollisionNode(data: BVHComputeDataLike) {
  const { index, attributes, transforms } = data.storage;
  const toWorld = mat4().toVar(`rzmps_capsuleToWorld_${Math.random().toString(36).slice(2)}`);

  const shapecast = data.getShapecastFn({
    name: `rzmps_CapsuleCast_${Math.random().toString(36).slice(2)}`,
    shapeStruct: capsuleQueryStruct,
    resultStruct: capsuleHitStruct,
    intersectsBoundsFn: wgslTagFn/* wgsl */`
      fn rzmpsCapsuleBounds(
        capsule: ${capsuleQueryStruct},
        bounds: ${bvhNodeBoundsStruct},
        result: ptr<function, ${capsuleHitStruct}>
      ) -> u32 {
        let bMin = vec3f(bounds.min[0], bounds.min[1], bounds.min[2]);
        let bMax = vec3f(bounds.max[0], bounds.max[1], bounds.max[2]);
        let center = (bMin + bMax) * 0.5;
        let extent = (bMax - bMin) * 0.5;
        let worldCenter = (${toWorld} * vec4f(center, 1.0)).xyz;
        let worldExtent =
          abs(${toWorld}[0].xyz) * extent.x +
          abs(${toWorld}[1].xyz) * extent.y +
          abs(${toWorld}[2].xyz) * extent.z;
        let capsuleMin = min(capsule.start, capsule.end) - capsule.radius;
        let capsuleMax = max(capsule.start, capsule.end) + capsule.radius;
        return select(0u, 1u, all(capsuleMax >= worldCenter - worldExtent) &&
          all(capsuleMin <= worldCenter + worldExtent));
      }
    `,
    intersectRangeFn: wgslTagFn/* wgsl */`
      fn rzmpsCapsuleRange(
        capsule: ${capsuleQueryStruct},
        offset: u32,
        count: u32,
        result: ptr<function, ${capsuleHitStruct}>
      ) -> bool {
        var didHit = false;
        let segment = capsule.end - capsule.start;
        let segmentLengthSq = dot(segment, segment);
        for (var triangleIndex = offset; triangleIndex < offset + count; triangleIndex++) {
          let i0 = ${index}[triangleIndex * 3u];
          let i1 = ${index}[triangleIndex * 3u + 1u];
          let i2 = ${index}[triangleIndex * 3u + 2u];
          let a = (${toWorld} * vec4f(${attributes}[i0].position.xyz, 1.0)).xyz;
          let b = (${toWorld} * vec4f(${attributes}[i1].position.xyz, 1.0)).xyz;
          let c = (${toWorld} * vec4f(${attributes}[i2].position.xyz, 1.0)).xyz;
          let rawNormal = cross(b - a, c - a);
          let normalLengthSq = dot(rawNormal, rawNormal);

          var capsulePoint = capsule.start;
          var trianglePoint = a;
          var bestDistanceSq = 3.402823466e+38;

          // Endpoint-to-triangle candidates include triangle interiors, edges, and vertices.
          let startBary = ${closestPointToTriangle}(capsule.start, a, b, c);
          let startPoint = startBary.x * a + startBary.y * b + startBary.z * c;
          let startDistanceSq = dot(capsule.start - startPoint, capsule.start - startPoint);
          if (startDistanceSq < bestDistanceSq) {
            bestDistanceSq = startDistanceSq; capsulePoint = capsule.start; trianglePoint = startPoint;
          }
          let endBary = ${closestPointToTriangle}(capsule.end, a, b, c);
          let endPoint = endBary.x * a + endBary.y * b + endBary.z * c;
          let endDistanceSq = dot(capsule.end - endPoint, capsule.end - endPoint);
          if (endDistanceSq < bestDistanceSq) {
            bestDistanceSq = endDistanceSq; capsulePoint = capsule.end; trianglePoint = endPoint;
          }

          // Segment-to-edge candidates handle edge and vertex contacts, including degenerate triangles.
          let edgeAB = rzmpsClosestSegmentSegment(capsule.start, capsule.end, a, b);
          let edgeBC = rzmpsClosestSegmentSegment(capsule.start, capsule.end, b, c);
          let edgeCA = rzmpsClosestSegmentSegment(capsule.start, capsule.end, c, a);
          let dAB = dot(edgeAB[0] - edgeAB[1], edgeAB[0] - edgeAB[1]);
          let dBC = dot(edgeBC[0] - edgeBC[1], edgeBC[0] - edgeBC[1]);
          let dCA = dot(edgeCA[0] - edgeCA[1], edgeCA[0] - edgeCA[1]);
          if (dAB < bestDistanceSq) { bestDistanceSq = dAB; capsulePoint = edgeAB[0]; trianglePoint = edgeAB[1]; }
          if (dBC < bestDistanceSq) { bestDistanceSq = dBC; capsulePoint = edgeBC[0]; trianglePoint = edgeBC[1]; }
          if (dCA < bestDistanceSq) { bestDistanceSq = dCA; capsulePoint = edgeCA[0]; trianglePoint = edgeCA[1]; }

          // A segment crossing the triangle plane has zero distance when the crossing lies in its interior.
          if (normalLengthSq > 1e-12 && segmentLengthSq > 1e-12) {
            let normal = rawNormal * inverseSqrt(normalLengthSq);
            let denominator = dot(segment, normal);
            if (abs(denominator) > 1e-12) {
              let t = dot(a - capsule.start, normal) / denominator;
              if (t >= 0.0 && t <= 1.0) {
                let crossing = capsule.start + segment * t;
                let bary = ${closestPointToTriangle}(crossing, a, b, c);
                let projected = bary.x * a + bary.y * b + bary.z * c;
                if (dot(crossing - projected, crossing - projected) <= 1e-10) {
                  bestDistanceSq = 0.0; capsulePoint = crossing; trianglePoint = crossing;
                }
              }
            }
          }

          if (bestDistanceSq <= capsule.radius * capsule.radius &&
              (!result.found || bestDistanceSq < result.distanceSq)) {
            let delta = capsulePoint - trianglePoint;
            let fallbackNormal = select(vec3f(0.0, 1.0, 0.0), normalize(rawNormal), normalLengthSq > 1e-12);
            result.normal = select(fallbackNormal, normalize(delta), bestDistanceSq > 1e-12);
            result.point = trianglePoint;
            result.capsulePoint = capsulePoint;
            result.distanceSq = bestDistanceSq;
            result.side = select(1.0, sign(dot(delta, fallbackNormal)), bestDistanceSq > 1e-12);
            result.found = true;
            didHit = true;
          }
        }
        return didHit;
      }

      fn rzmpsClosestSegmentSegment(
        p1: vec3f, q1: vec3f, p2: vec3f, q2: vec3f
      ) -> mat2x3f {
        let d1 = q1 - p1;
        let d2 = q2 - p2;
        let r = p1 - p2;
        let a = dot(d1, d1);
        let e = dot(d2, d2);
        let f = dot(d2, r);
        var s = 0.0;
        var t = 0.0;
        if (a <= 1e-12 && e <= 1e-12) {
          return mat2x3f(p1, p2);
        } else if (a <= 1e-12) {
          t = clamp(f / max(e, 1e-12), 0.0, 1.0);
        } else {
          let c = dot(d1, r);
          if (e <= 1e-12) {
            s = clamp(-c / a, 0.0, 1.0);
          } else {
            let b = dot(d1, d2);
            let denom = a * e - b * b;
            if (abs(denom) > 1e-12) { s = clamp((b * f - c * e) / denom, 0.0, 1.0); }
            t = (b * s + f) / e;
            if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }
            else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }
          }
        }
        return mat2x3f(p1 + d1 * s, p2 + d2 * t);
      }
    `,
    transformShapeFn: wgslTagFn/* wgsl */`
      fn rzmpsCapsuleTransform(shape: ptr<function, ${capsuleQueryStruct}>, objectIndex: u32) -> void {
        ${toWorld} = ${transforms}[objectIndex].matrixWorld;
      }
    `,
    resetShapeFn: wgslTagFn/* wgsl */`
      fn rzmpsCapsuleReset(objectIndex: u32) -> void {
        ${toWorld} = mat4x4f(
          1.0, 0.0, 0.0, 0.0,
          0.0, 1.0, 0.0, 0.0,
          0.0, 0.0, 1.0, 0.0,
          0.0, 0.0, 0.0, 1.0
        );
      }
    `,
    transformResultFn: wgslTagFn/* wgsl */`
      fn rzmpsCapsuleResult(result: ptr<function, ${capsuleHitStruct}>, objectIndex: u32) -> void {
        result.objectIndex = objectIndex;
      }
    `,
  });

  // Allocate the pointer result in WGSL function scope. TSL variables use the
  // private address space, which cannot be passed to a ptr<function> parameter.
  const query = wgslTagFn/* wgsl */`
    fn rzmpsQueryCapsule(shape: ${capsuleQueryStruct}) -> ${capsuleHitStruct} {
      var result: ${capsuleHitStruct};
      result.found = false;
      result.point = vec3f(0.0);
      result.capsulePoint = vec3f(0.0);
      result.normal = vec3f(0.0, 1.0, 0.0);
      result.distanceSq = 3.402823466e+38;
      result.side = 1.0;
      result.objectIndex = 0u;
      result.found = ${shapecast}(shape, &result);
      return result;
    }
  `;
  return (capsule: Node) => nodeObject(
    new CapsuleQueryCallNode(query as unknown as Node, capsule),
  );
}
