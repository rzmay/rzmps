import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { SurfaceSample } from './surfaceSample.types';

/** CPU companion to the GPU collision BVH. World-space triangle tests also handle nonuniform scaling. */
export function createMeshSurfaceQuery() {
  const geometryTrees = new Map<THREE.BufferGeometry, { tree: MeshBVH; version: number }>();
  const motion = new Map<THREE.Mesh, { previous: THREE.Matrix4; inverse: THREE.Matrix4 }>();
  let meshes: THREE.Mesh[] = [], deltaTime = 0;
  const triangle = new THREE.Triangle(), point = new THREE.Vector3(), normal = new THREE.Vector3();

  return {
    update(surface: THREE.Object3D, dt: number) {
      surface.updateWorldMatrix(true, true);
      deltaTime = dt;
      meshes = [];
      surface.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !object.geometry.getAttribute('position')) return;
        meshes.push(object);
        const previous = motion.get(object);
        motion.set(object, { previous: previous ? previous.inverse.clone().invert() : object.matrixWorld.clone(),
          inverse: object.matrixWorld.clone().invert() });
        const geometry = object.geometry, version = geometry.getAttribute('position').version;
        const existing = geometryTrees.get(geometry);
        if (!existing) geometryTrees.set(geometry, { tree: new MeshBVH(geometry, { indirect: true }), version });
        else if (existing.version !== version) { existing.tree.refit(); existing.version = version; }
      });
      for (const mesh of motion.keys()) if (!meshes.includes(mesh)) motion.delete(mesh);
      for (const geometry of geometryTrees.keys())
        if (!meshes.some(mesh => mesh.geometry === geometry)) geometryTrees.delete(geometry);
    },
    sample(position: THREE.Vector3): SurfaceSample {
      let distanceSq = Infinity, selected: THREE.Mesh | undefined;
      const closest = new THREE.Vector3(), outward = new THREE.Vector3();
      for (const mesh of meshes) geometryTrees.get(mesh.geometry)!.tree.shapecast({
        intersectsBounds: bounds => bounds.clone().applyMatrix4(mesh.matrixWorld).distanceToPoint(position) ** 2
          <= distanceSq,
        intersectsTriangle: local => {
          triangle.copy(local);
          triangle.a.applyMatrix4(mesh.matrixWorld);
          triangle.b.applyMatrix4(mesh.matrixWorld);
          triangle.c.applyMatrix4(mesh.matrixWorld);
          triangle.closestPointToPoint(position, point);
          const candidate = point.distanceToSquared(position);
          if (candidate < distanceSq) {
            distanceSq = candidate; selected = mesh;
            closest.copy(point); triangle.getNormal(outward);
          }
          return false;
        },
      });
      if (!selected) return { distance: 0, normal: new THREE.Vector3(0, 1, 0),
        velocity: new THREE.Vector3(), valid: false };
      const delta = position.clone().sub(closest), sign = delta.dot(outward) < 0 ? -1 : 1;
      normal.copy(distanceSq > 1e-16 ? delta.multiplyScalar(sign / Math.sqrt(distanceSq)) : outward);
      const state = motion.get(selected)!;
      const previous = closest.clone().applyMatrix4(state.inverse).applyMatrix4(state.previous);
      return { distance: Math.sqrt(distanceSq) * sign, normal: normal.clone(),
        velocity: deltaTime > 0 ? closest.clone().sub(previous).divideScalar(deltaTime) : new THREE.Vector3(),
        valid: true };
    },
    dispose() { meshes = []; motion.clear(); geometryTrees.clear(); },
  };
}
