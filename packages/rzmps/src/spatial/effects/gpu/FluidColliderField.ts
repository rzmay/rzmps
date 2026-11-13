import * as THREE from 'three';
import { StorageBufferAttribute, Storage3DTexture, type ComputeNode, type Node } from 'three/webgpu';
import { Fn, If, float, instanceIndex, storage, texture3D, textureStore, vec3, vec4 } from 'three/tsl';
import { destroyGPUStorageAttribute } from '../../../simulation/gpu/Particle';
import getAttributeVersion from '../../../utils/getAttributeVersion';
import type { ParticleSpatialGridRenderer } from '../../structures/ParticleSpatialGrid';
// @ts-expect-error upstream deep entry point has no declaration
import { BVHComputeData } from 'three-mesh-bvh/src/webgpu/BVHComputeData.js';
// @ts-expect-error upstream deep entry point has no declaration
import { wgslTagFn } from 'three-mesh-bvh/src/webgpu/nodes/WGSLTagFnNode.js';
// @ts-expect-error upstream deep entry point has no declaration
import { bvhNodeBoundsStruct, pointQueryResultStruct } from 'three-mesh-bvh/src/webgpu/tsl/structs.js';

const CACHE = Symbol('rzmps.fluid-bake.v1');
const observedGeometry = new WeakSet<THREE.BufferGeometry>();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | null): number {
  if (!value) return 0;
  if (!identities.has(value)) identities.set(value, ++nextIdentity);
  return identities.get(value)!;
}
interface CacheEntry {
  revision: string;
  resources: Set<WeakRef<FluidColliderField>>;
  bounds: THREE.Box3;
  closed: boolean;
  compact?: Uint8Array;
  sessions: WeakMap<object, FluidColliderField>;
}

/** Local-space binary GPU occupancy. Geometry owns reusable data; transforms never enter its cache key. @internal */
export default class FluidColliderField {
  readonly attribute: StorageBufferAttribute;
  readonly texture: Storage3DTexture;
  readonly bounds: THREE.Box3;
  readonly cacheHit: boolean;
  readonly nodes: ComputeNode[] = [];
  readonly values;
  private data?: { dispose(): void };
  readonly metrics = { lookupMs: 0, classificationMs: 0, bvhPackingMs: 0,
    submissionMs: 0, completionMs: 0, uploadMs: 0 };

  static acquire(
    geometry: THREE.BufferGeometry,
    resolution: number,
    thickness: number,
    inverted: boolean,
    renderer: ParticleSpatialGridRenderer,
  ): FluidColliderField {
    const start = performance.now();
    const position = geometry.getAttribute('position');
    const key = [
      identity(position),
      identity(geometry.index),
      position.count,
      getAttributeVersion(position),
      geometry.index?.count,
      getAttributeVersion(geometry.index),
    ].join(':');
    const revision = key;
    const fullKey = [revision, resolution, thickness, inverted, 1].join(':');
    const userData = geometry.userData as Record<symbol, Map<string, CacheEntry>>;
    const cache = (userData[CACHE] ??= new Map());
    for (const [key, old] of cache)
      if (old.revision !== revision) {
        old.resources.forEach(ref => ref.deref()?.release());
        cache.delete(key);
      }
    if (!observedGeometry.has(geometry)) {
      observedGeometry.add(geometry);
      geometry.addEventListener('dispose', () => {
        for (const entry of cache.values()) {
          entry.resources.forEach(ref => ref.deref()?.release());
          entry.resources.clear();
          entry.sessions = new WeakMap();
        }
      });
    }
    let entry = cache.get(fullKey);
    const existing = entry?.sessions.get(renderer);
    if (existing) { existing.metrics.lookupMs = performance.now() - start; return existing; }
    const lookupMs = performance.now() - start;
    const classificationStart = performance.now();
    if (!entry) {
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox!.clone().expandByScalar(thickness);
      bounds.max.max(bounds.min.clone().addScalar(1e-6));
      entry = { bounds, closed: isClosed(geometry), sessions: new WeakMap(), revision, resources: new Set() };
      cache.set(fullKey, entry);
    }
    const classificationMs = performance.now() - classificationStart;
    const result = new FluidColliderField(geometry, resolution, thickness, inverted, renderer, entry);
    result.metrics.lookupMs = lookupMs;
    result.metrics.classificationMs = classificationMs;
    entry.sessions.set(renderer, result);
    entry.resources.add(new WeakRef(result));
    return result;
  }

  private constructor(
    geometry: THREE.BufferGeometry,
    readonly resolution: number,
    thickness: number,
    inverted: boolean,
    private readonly renderer: ParticleSpatialGridRenderer,
    entry: CacheEntry,
  ) {
    this.bounds = entry.bounds;
    this.cacheHit = !!entry.compact;
    this.texture = new Storage3DTexture(resolution, resolution, resolution);
    this.texture.type = THREE.UnsignedByteType;
    this.attribute = new StorageBufferAttribute(new Float32Array(resolution ** 3), 1);
    this.values = storage(this.attribute, 'float', resolution ** 3);
    if (entry.compact) {
      const start = performance.now();
      (this.attribute.array as Float32Array).set(entry.compact);
      const upload = Fn(() => {
        const i = instanceIndex;
        const c = vec3(
          float(i.mod(resolution)),
          float(i.div(resolution).mod(resolution)),
          float(i.div(resolution * resolution)),
        );
        textureStore(this.texture, c, vec4(this.values.element(i), 0, 0, 1)).toWriteOnly();
      })().compute(resolution ** 3);
      this.nodes.push(upload);
      renderer.compute(upload);
      this.metrics.uploadMs = performance.now() - start;
      return;
    }

    // BVH packing is reused from particle collision. Only containment evaluation moves to the GPU.
    const packingStart = performance.now();
    const data = new BVHComputeData(geometry.clone(), { attributes: { position: 'vec4f' } });
    data.update();
    this.metrics.bvhPackingMs = performance.now() - packingStart;
    this.data = data;
    const { index, attributes } = data.storage;
    const parity = data.getShapecastFn({
      name: 'rzmpsFluidParity',
      shapeStruct: 'vec3f',
      resultStruct: 'u32',
      intersectsBoundsFn: wgslTagFn /* wgsl */ `
        fn fluidRayBounds(p: vec3f, bounds: ${bvhNodeBoundsStruct}, result: ptr<function, u32>) -> u32 {
          let d = normalize(vec3f(1.0, 0.371, 0.529));
          let a = (vec3f(bounds.min[0], bounds.min[1], bounds.min[2]) - p) / d;
          let b = (vec3f(bounds.max[0], bounds.max[1], bounds.max[2]) - p) / d;
          let lo = min(a, b); let hi = max(a, b);
          return select(0u, 1u, min(min(hi.x, hi.y), hi.z) >= max(0.0, max(max(lo.x, lo.y), lo.z)));
        }
      `,
      intersectRangeFn: wgslTagFn /* wgsl */ `
        fn fluidRayRange(p: vec3f, offset: u32, count: u32, result: ptr<function, u32>) -> bool {
          let d = normalize(vec3f(1.0, 0.371, 0.529));
          let u = normalize(vec3f(-d.y, d.x, 0.0)); let v = cross(d, u);
          for (var i = offset; i < offset + count; i++) {
            let a = ${attributes}[${index}[i * 3u]].position.xyz - p;
            let b = ${attributes}[${index}[i * 3u + 1u]].position.xyz - p;
            let c = ${attributes}[${index}[i * 3u + 2u]].position.xyz - p;
            let n = cross(b - a, c - a); let denominator = dot(d, n);
            if (abs(denominator) < 1e-15 || dot(a, n) / denominator < 0.0) { continue; }
            var q = array<vec2f, 3>(vec2f(dot(a, u), dot(a, v)), vec2f(dot(b, u), dot(b, v)),
              vec2f(dot(c, u), dot(c, v)));
            let ab = q[1] - q[0]; let ac = q[2] - q[0];
            if (ab.x * ac.y - ab.y * ac.x < 0.0) { let temp = q[1]; q[1] = q[2]; q[2] = temp; }
            var hit = true;
            for (var edge = 0u; edge < 3u; edge++) {
              let first = q[edge]; let delta = q[(edge + 1u) % 3u] - first;
              let e = delta.x * (-first.y) - delta.y * (-first.x);
              // Half-open projected edges count a shared triangle edge/vertex exactly once.
              let topLeft = delta.y > 0.0 || (delta.y == 0.0 && delta.x < 0.0);
              hit = hit && (e > 0.0 || (e == 0.0 && topLeft));
            }
            if (hit) { *result += 1u; }
          }
          return false;
        }
      `,
    });
    const classify = wgslTagFn /* wgsl */ `
      fn fluidInside(p: vec3f) -> f32 {
        var hits = 0u;
        ${parity}(p, &hits);
        return f32(hits & 1u);
      }
    `;
    const distance = wgslTagFn/* wgsl */`
      fn fluidShellDistance(p: vec3f) -> f32 {
        var result: ${pointQueryResultStruct};
        result.found = false;
        result.distanceSq = 3.402823466e+38;
        ${data.fns.closestPointToPoint}(p, &result);
        return select(3.402823466e+38, result.distanceSq, result.found);
      }
    `;
    const minimum = vec3(this.bounds.min);
    const size = vec3(this.bounds.getSize(new THREE.Vector3()));
    const bake = Fn(() => {
      const i = instanceIndex;
      const coordinate = vec3(
        float(i.mod(resolution)),
        float(i.div(resolution).mod(resolution)),
        float(i.div(resolution * resolution)),
      );
      const point = minimum.add(coordinate.div(resolution - 1).mul(size));
      const occupied = (entry.closed ? classify(point) : float(0)).toVar();
      if (thickness > 0) {
        If(occupied.lessThan(1), () => {
          occupied.assign(distance(point).lessThanEqual(thickness ** 2 * (1 + 1e-5)).select(1, 0));
        });
      }
      const value = inverted ? float(1).sub(occupied) : occupied;
      this.values.element(i).assign(value);
      textureStore(this.texture, coordinate, vec4(value, 0, 0, 1)).toWriteOnly();
    })().compute(resolution ** 3);
    this.nodes.push(bake);
    const start = performance.now();
    renderer.compute(bake);
    this.metrics.submissionMs = performance.now() - start;
    // Compact readback is optional cache population, never a prerequisite for simulation.
    void renderer
      .getArrayBufferAsync(this.attribute)
      .then(buffer => {
        entry.compact = Uint8Array.from(new Float32Array(buffer), value => (value > 0 ? 1 : 0));
        this.metrics.completionMs = performance.now() - start;
      })
      .catch(() => {});
  }

  sample(position: Node<'vec3'>, inverted: boolean): Node<'float'> {
    const uv = position.sub(vec3(this.bounds.min)).div(vec3(this.bounds.getSize(new THREE.Vector3())));
    const texel = uv
      .clamp(0, 1)
      .mul(this.resolution - 1)
      .add(0.5)
      .div(this.resolution);
    const value = texture3D(this.texture, texel).r;
    return uv
      .greaterThanEqual(0)
      .all()
      .and(uv.lessThanEqual(1).all())
      .select(value, float(inverted ? 1 : 0));
  }

  private release(): void {
    const renderer = this.renderer as unknown as {
      backend: { device: { queue: { onSubmittedWorkDone(): Promise<void> } } };
    };
    void renderer.backend.device.queue.onSubmittedWorkDone().then(
      () => this.dispose(),
      () => this.dispose(),
    );
  }

  dispose(): void {
    this.nodes.forEach(node => node.dispose());
    destroyGPUStorageAttribute(this.renderer, this.attribute);
    this.attribute.dispose();
    this.texture.dispose();
    this.data?.dispose();
  }
}

/** Weld positions for topology classification, without per-voxel CPU geometry queries. */
function isClosed(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  const epsilon = Math.max(geometry.boundingBox!.getSize(new THREE.Vector3()).length() * 1e-6, 1e-9);
  const vertices = new Map<string, number>();
  const ids = Array.from({ length: position.count }, (_, i) => {
    const key = [position.getX(i), position.getY(i), position.getZ(i)].map(v => Math.round(v / epsilon)).join(',');
    if (!vertices.has(key)) vertices.set(key, vertices.size);
    return vertices.get(key)!;
  });
  const edges = new Map<string, number>();
  const count = geometry.index?.count ?? position.count;
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map(j => ids[geometry.index?.getX(i + j) ?? i + j]);
    if (new Set(triangle).size < 3) continue;
    for (let edge = 0; edge < 3; edge++) {
      const a = triangle[edge],
        b = triangle[(edge + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges.size > 0 && [...edges.values()].every(count => count === 2);
}
