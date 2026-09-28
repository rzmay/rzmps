import { Fn, int, vec3, float, Loop, struct } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { FlattenedOctree } from './octreeFlattener';

// Typescript representation mirroring the TSL argument proxy boundaries
export interface CollisionQuery {
  start: Node<'vec3'>;     // vec3
  end: Node<'vec3'>;       // vec3
  velocity: Node<'vec3'>;  // vec3
  radius: Node<'float'>;    // float
  mass: Node<'float'>;      // float (Optional: defaults to 1.0 if skipped)
}

// Shader Struct Definition to return structured output parameters natively
const CollisionHitStruct = struct({
  point: 'vec3',
  normal: 'vec3',
  impulse: 'vec3',
  position: 'vec3'
});

export function capsuleOctreeCollisionNode({ nodes, triangles }: FlattenedOctree) {
  // Returns standard execution Fn() wrapper mapped to user parameters
  return Fn(([query]: [CollisionQuery]) => {
    const capsuleStart = query.start;
    const capsuleEnd = query.end;
    const velocity = query.velocity;
    const radius = query.radius;
    const mass = query.mass;

    // Local Traversal Allocations
    const stack = int(-1).toArray(24);
    const stackPtr = int(0).toVar();
    stack.element(stackPtr).assign(int(0)); // Start at root node index 0

    // Output Struct Node tracker initialization
    const hit = CollisionHitStruct();
    hit.get('point').assign(vec3(0, 0, 0));
    hit.get('normal').assign(vec3(0, 0, 0));
    hit.get('impulse').assign(vec3(0, 0, 0));
    hit.get('position').assign(capsuleStart); // Default position fallback

    // Tracking the minimum distance to locate the absolute closest collision instance
    const minDistance = float(radius).toVar();
    const hasHitOccurred = int(0).toVar();

    Loop(() => {
      if (stackPtr.lessThan(int(0))) return;

      const currentNodeIdx = int(stack.element(stackPtr)).toVar();
      stackPtr.subAssign(int(1));

      const baseOffset = int(currentNodeIdx.mul(int(4))).toVar();

      // Read Vec4 0: Bounding Information
      const boundsData = nodes.element(baseOffset);
      const center = vec3(boundsData.xyz);
      const halfExtent = float(boundsData.w);

      // Expand bounding box checks dynamically to catch early radius contacts
      const expandedExtent = float(halfExtent.add(radius));
      const clampedPos = vec3(
        capsuleStart.x.clamp(center.x.sub(expandedExtent), center.x.add(expandedExtent)),
        capsuleStart.y.clamp(center.y.sub(expandedExtent), center.y.add(expandedExtent)),
        capsuleStart.z.clamp(center.z.sub(expandedExtent), center.z.add(expandedExtent))
      );

      if (float(capsuleStart.distance(clampedPos)).greaterThan(radius)) {
        return; // Early prune path branch
      }

      // Read Vec4 1: Geometry Leaf Meta
      const metaData = nodes.element(baseOffset.add(int(1)));
      const triStart = int(metaData.x);
      const triCount = int(metaData.y);

      if (triStart.greaterThanEqual(int(0))) {
        Loop({ start: int(0), end: triCount }, ({ i }) => {
          const triIdx = int(triStart.add(i).mul(int(3)));

          const vA = vec3(triangles.element(triIdx));
          const vB = vec3(triangles.element(triIdx.add(int(1))));
          const vC = vec3(triangles.element(triIdx.add(int(2))));

          // --- CAPSULE-TRIANGLE NARROW PHASE INTERSECTION ---
          const edge0 = vec3(vB.sub(vA));
          const edge1 = vec3(vC.sub(vA));
          const triNormal = vec3(edge0.cross(edge1).normalize());

          const segVector = vec3(capsuleEnd.sub(capsuleStart));
          const segLengthSq = float(segVector.lengthSq());

          const num = float(vA.sub(capsuleStart).dot(triNormal));
          const denom = float(segVector.dot(triNormal));
          const tPlane = float(num.div(denom).clamp(0.0, 1.0));
          const planeProjPoint = vec3(capsuleStart.add(segVector.mul(tPlane)));

          // Barycentric Triangle Surface Projections
          const v0 = vec3(vC.sub(vA));
          const v1 = vec3(vB.sub(vA));
          const v2 = vec3(planeProjPoint.sub(vA));

          const dot00 = float(v0.dot(v0));
          const dot01 = float(v0.dot(v1));
          const dot02 = float(v0.dot(v2));
          const dot11 = float(v1.dot(v1));
          const dot12 = float(v1.dot(v2));

          const invDenom = float(float(1.0).div(dot00.mul(dot11).sub(dot01.mul(dot01))));
          const u = float(dot11.mul(dot02).sub(dot01.mul(dot12)).mul(invDenom));
          const v = float(dot00.mul(dot12).sub(dot01.mul(dot02)).mul(invDenom));

          const closestTriPoint = vec3(vA).toVar(); // Fallback allocation
          if (u.greaterThanEqual(0.0).and(v.greaterThanEqual(0.0)).and(u.add(v).lessThanEqual(1.0))) {
            closestTriPoint.assign(planeProjPoint);
          }

          // Compute matching capsule line segment node parameters
          const tSeg = float(closestTriPoint.sub(capsuleStart).dot(segVector).div(segLengthSq).clamp(0.0, 1.0));
          const closestCapsulePoint = vec3(capsuleStart.add(segVector.mul(tSeg)));

          const separationVector = vec3(closestCapsulePoint.sub(closestTriPoint));
          const distance = float(separationVector.length());

          // Track the closest point of intersection across leaf geometry
          if (distance.lessThan(minDistance)) {
            minDistance.assign(distance);
            hasHitOccurred.assign(int(1));

            const finalNormal = vec3(distance.equal(0.0).select(triNormal, separationVector.normalize()));
            const penetrationDepth = float(radius.sub(distance));

            // Populate active properties inside struct allocations
            hit.get('point').assign(closestTriPoint);
            hit.get('normal').assign(finalNormal);
            hit.get('position').assign(capsuleStart.add(finalNormal.mul(penetrationDepth)));

            // Calculate Normal Impact Impulse Equation: (normal . velocity) * mass * normal
            const normalVelocity = float(velocity.dot(finalNormal));
            const normalImpactSpeed = float(normalVelocity.min(0.0).abs()); // Apply only on structural approach vectors
            hit.get('impulse').assign(finalNormal.mul(normalImpactSpeed.mul(mass)));
          }
        });
      }

      // Read Vec4 2 & 3: Evaluate Child Nodes
      const children1 = nodes.element(baseOffset.add(int(2)));
      const children2 = nodes.element(baseOffset.add(int(3)));

      const bitX = int(capsuleStart.x.greaterThan(center.x).select(int(1), int(0)));
      const bitY = int(capsuleStart.y.greaterThan(center.y).select(int(2), int(0)));
      const bitZ = int(capsuleStart.z.greaterThan(center.z).select(int(4), int(0)));
      const targetOctant = int(bitX.add(bitY).add(bitZ));

      const nextChildIdx = int(-1).toVar();
      if (targetOctant.equal(int(0))) nextChildIdx.assign(int(children1.x));
      if (targetOctant.equal(int(1))) nextChildIdx.assign(int(children1.y));
      if (targetOctant.equal(int(2))) nextChildIdx.assign(int(children1.z));
      if (targetOctant.equal(int(3))) nextChildIdx.assign(int(children1.w));
      if (targetOctant.equal(int(4))) nextChildIdx.assign(int(children2.x));
      if (targetOctant.equal(int(5))) nextChildIdx.assign(int(children2.y));
      if (targetOctant.equal(int(6))) nextChildIdx.assign(int(children2.z));
      if (targetOctant.equal(int(7))) nextChildIdx.assign(int(children2.w));

      if (nextChildIdx.greaterThanEqual(int(0))) {
        stackPtr.addAssign(int(1));
        stack.element(stackPtr).assign(nextChildIdx);
      }
    });

    return hit;
  });
}
