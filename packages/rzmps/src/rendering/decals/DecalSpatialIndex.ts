import * as THREE from 'three';

interface Entry<T> {
  value: T;
  receiver: THREE.Object3D;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  key: string;
}

/** Receiver-local buckets survive rigid motion; final distances are measured in world units. @internal */
export default class DecalSpatialIndex<T extends object> {
  private readonly receivers = new Map<THREE.Object3D, Map<string, Set<Entry<T>>>>();
  private readonly entries = new Map<T, Entry<T>>();
  private readonly cellSize = 0.25;

  add(value: T, receiver: THREE.Object3D, point: THREE.Vector3, normal: THREE.Vector3): void {
    receiver.updateWorldMatrix(true, false);
    const local = point.clone().applyMatrix4(receiver.matrixWorld.clone().invert());
    const localNormal = normal.clone().applyMatrix3(new THREE.Matrix3()
      .getNormalMatrix(receiver.matrixWorld).invert()).normalize();
    const key = local.toArray().map(v => Math.floor(v / this.cellSize)).join(':');

    let buckets = this.receivers.get(receiver);
    if (!buckets) {
      buckets = new Map();
      this.receivers.set(receiver, buckets);
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new Set();
      buckets.set(key, bucket);
    }

    const entry = { value, receiver, point: local, normal: localNormal, key };
    bucket.add(entry);
    this.entries.set(value, entry);
  }

  remove(value: T): void {
    const entry = this.entries.get(value);
    if (!entry) return;

    const buckets = this.receivers.get(entry.receiver)!;
    const bucket = buckets.get(entry.key)!;
    bucket.delete(entry);
    if (!bucket.size) buckets.delete(entry.key);
    if (!buckets.size) this.receivers.delete(entry.receiver);
    this.entries.delete(value);
  }

  query(receiver: THREE.Object3D, point: THREE.Vector3, radius: number, normal?: THREE.Vector3, strict = false): T[] {
    if (!Number.isFinite(radius) || radius < 0) {
      throw new RangeError('Decal query radius must be finite and nonnegative.');
    }

    const buckets = this.receivers.get(receiver);
    if (!buckets) return [];

    receiver.updateWorldMatrix(true, false);
    const inverse = receiver.matrixWorld.clone().invert();
    const local = point.clone().applyMatrix4(inverse);
    // Frobenius norm conservatively bounds the inverse scale, including sheared parents.
    const e = inverse.elements;
    const reach = radius * Math.hypot(e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]);
    const low = local.clone().addScalar(-reach).divideScalar(this.cellSize).floor();
    const high = local.clone().addScalar(reach).divideScalar(this.cellSize).floor();
    const linear = new THREE.Matrix3().setFromMatrix4(receiver.matrixWorld);
    const normals = new THREE.Matrix3().getNormalMatrix(receiver.matrixWorld);
    const queryNormal = normal?.clone().normalize();

    const results: { value: T; distance: number }[] = [];
    const visit = (bucket?: Set<Entry<T>>) => {
      for (const entry of bucket ?? []) {
        const delta = entry.point.clone().sub(local).applyMatrix3(linear);
        const distance = delta.lengthSq();
        if (strict ? distance >= radius * radius : distance > radius * radius) continue;
        if (queryNormal) {
          const n = entry.normal.clone().applyMatrix3(normals).normalize();
          const alignment = n.dot(queryNormal);
          if (alignment < 0.75) continue;
          // Symmetric tangent test accepts smooth curvature, but rejects parallel separated sheets.
          const tolerance = Math.max(1e-4, radius * Math.sqrt(Math.max(0, 1 - alignment)) * 0.5);
          if (Math.abs(delta.dot(n.add(queryNormal))) > tolerance) continue;
        }
        results.push({ value: entry.value, distance });
      }
    };

    // Sparse bucket traversal avoids iterating enormous empty ranges for large query radii.
    const cells = (high.x - low.x + 1) * (high.y - low.y + 1) * (high.z - low.z + 1);
    if (cells > buckets.size) {
      for (const [key, bucket] of buckets) {
        const [x, y, z] = key.split(':').map(Number);
        if (x >= low.x && x <= high.x && y >= low.y && y <= high.y && z >= low.z && z <= high.z) visit(bucket);
      }
    } else {
      for (let z = low.z; z <= high.z; z++) for (let y = low.y; y <= high.y; y++) {
        for (let x = low.x; x <= high.x; x++) visit(buckets.get(`${x}:${y}:${z}`));
      }
    }

    return results.sort((a, b) => a.distance - b.distance).map(result => result.value);
  }

  clear(): void {
    this.receivers.clear();
    this.entries.clear();
  }
}
