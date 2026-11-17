import { Node, type StructTypeNode } from 'three/webgpu';
import { nodeObject } from 'three/tsl';
// @ts-expect-error incomplete upstream WebGPU declarations
import { pointQueryResultStruct } from 'three-mesh-bvh/src/webgpu/tsl/structs.js';
// @ts-expect-error incomplete upstream WebGPU declarations
import { getClosestPointToPointFn } from 'three-mesh-bvh/src/webgpu/shapecastFns/getClosestPointToPointFn.js';
// @ts-expect-error incomplete upstream WebGPU declarations
import { wgslTagFn } from 'three-mesh-bvh/src/webgpu/nodes/WGSLTagFnNode.js';
import type { BVHComputeDataLike } from './capsuleBVHCollisionNode';

// The upstream shapecast writes through a result pointer. Match the existing capsule struct-call convention.
class SurfaceQueryCall extends Node {
  constructor(private readonly query: Node, private readonly point: Node, private readonly result: StructTypeNode) {
    super('vec3');
  }
  generateNodeType(builder: Parameters<Node['build']>[0]): string { return this.result.getNodeType(builder); }
  getMemberType(builder: Parameters<Node['build']>[0], name: string): string {
    return this.result.getMemberType(builder, name);
  }
  generate(builder: Parameters<Node['build']>[0]): string {
    return `${this.query.build(builder, 'property')}( ${this.point.build(builder)} )`;
  }
}

/** Closest world-space surface query over the collision backend's existing packed TLAS/BLAS. */
export default function createClosestSurfaceQuery(data: BVHComputeDataLike) {
  const shapecast = getClosestPointToPointFn(data);
  const name = `rzmpsClosestSurface_${Math.random().toString(36).slice(2)}`;
  const query = wgslTagFn/* wgsl */`
    fn ${name}(point: vec3f) -> ${pointQueryResultStruct} {
      var result: ${pointQueryResultStruct};
      result.found = false;
      result.distanceSq = 3.402823466e+38;
      result.closestPoint = point;
      result.faceNormal = vec3f(0.0, 1.0, 0.0);
      result.objectIndex = 0u;
      result.found = ${shapecast}(point, &result);
      return result;
    }
  `;
  return (point: Node) => nodeObject(new SurfaceQueryCall(query as Node, point, pointQueryResultStruct));
}
