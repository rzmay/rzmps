import * as THREE from 'three';
import { Storage3DTexture, StorageBufferAttribute, type Node, type WebGPURenderer } from 'three/webgpu';
import { Fn, If, Loop, float, mat4, max, storage, texture3D, uniform, vec3, vec4 } from 'three/tsl';
import type FluidColliderField from './FluidColliderField';

interface ColliderQueryEntry {
  field: FluidColliderField;
  inverse: THREE.Matrix4;
  motion: THREE.Matrix4;
  inverted: boolean;
}

type QueryStorage = { element(index: Node | number): Node<'vec4'> };
type ColliderQuery = (position: Node<'vec3'>) => Node<'vec4'>;
type ColliderGPUDevice = {
  limits: { maxTextureDimension3D: number };
  queue: { onSubmittedWorkDone(): Promise<void> };
};

// Matrices occupy four vec4 columns each; the remaining records describe the field and atlas tile.
const QUERY_LAYOUT = { inverse: 0, motion: 4, minimum: 8, extent: 9, atlasOffset: 10 } as const;
const QUERY_VECTORS = 11;
const QUERY_FLOATS = QUERY_VECTORS * 4;
const DIRECT_FIELD_LIMIT = 8;

/** Packs cached occupancy fields into one sampled binding for scenes with many mesh colliders. @internal */
export default class FluidColliderAtlas {
  texture?: Storage3DTexture;
  queryVersion = 0;

  private fields: FluidColliderField[] = [];
  private queryAttribute?: StorageBufferAttribute;
  private queryStorage?: QueryStorage;
  private readonly queryCount = uniform(0, 'uint');
  private readonly simulationToWorld = uniform(new THREE.Matrix4());
  private readonly offsets = new Map<FluidColliderField, THREE.Vector3>();
  private renderer?: WebGPURenderer;
  private readonly size = new THREE.Vector3();

  private get device(): ColliderGPUDevice {
    return (this.renderer!.backend as unknown as { device: ColliderGPUDevice }).device;
  }

  update(fields: FluidColliderField[], renderer: WebGPURenderer): void {
    if (
      renderer === this.renderer &&
      fields.length === this.fields.length &&
      fields.every((field, i) => field === this.fields[i])
    ) {
      return;
    }

    this.dispose();
    this.renderer = renderer;
    this.fields = fields;

    // Small scenes retain direct sampling, with no copy or extra texture allocation.
    if (fields.length <= DIRECT_FIELD_LIMIT) return;

    const tile = Math.max(...fields.map(field => field.resolution));
    const columns = Math.ceil(Math.cbrt(fields.length));
    const rows = Math.ceil(Math.sqrt(fields.length / columns));
    const layers = Math.ceil(fields.length / (columns * rows));
    const size = new THREE.Vector3(columns, rows, layers).multiplyScalar(tile);
    const limit = this.device.limits.maxTextureDimension3D;
    if (Math.max(size.x, size.y, size.z) > limit) {
      throw new Error('Fluid collider occupancy atlas exceeds maxTextureDimension3D; reduce bakedFieldResolution.');
    }

    const texture = new Storage3DTexture(size.x, size.y, size.z);
    texture.type = THREE.UnsignedByteType;
    texture.generateMipmaps = false;
    texture.name = 'Fluid collider occupancy atlas';
    this.texture = texture;
    this.size.copy(size);
    fields.forEach((field, index) => {
      const offset = new THREE.Vector3(
        index % columns,
        Math.floor(index / columns) % rows,
        Math.floor(index / (columns * rows)),
      ).multiplyScalar(tile);
      this.offsets.set(field, offset);
      // Ordered GPU copies reuse the existing geometry bake without CPU readback or reclassification.
      const region = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3().setScalar(field.resolution));
      renderer.copyTextureToTexture(field.texture, texture, region, offset);
    });
  }

  /** Refresh transforms and field records without rebuilding the cached boundary program. */
  updateQueries(entries: ColliderQueryEntry[], simulationToWorld: THREE.Matrix4): void {
    this.simulationToWorld.value.copy(simulationToWorld);
    this.reserveQueries(entries.length);

    const data = this.queryAttribute!.array as Float32Array;
    entries.forEach((entry, index) => this.writeQueryEntry(data, index, entry));

    this.queryCount.value = entries.length;
    this.queryAttribute!.needsUpdate = true;
  }

  /** Geometric growth keeps the parameter binding stable while collider count stays within its reservation. */
  private reserveQueries(count: number): void {
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, count)));
    if (this.queryAttribute && this.queryAttribute.count >= capacity * QUERY_VECTORS) return;

    const previous = this.queryAttribute;
    this.queryAttribute = new StorageBufferAttribute(new Float32Array(capacity * QUERY_FLOATS), 4);
    this.queryStorage = storage(this.queryAttribute, 'vec4', capacity * QUERY_VECTORS);
    this.queryVersion++;

    if (previous) {
      const release = () => previous.dispose();
      void this.device.queue.onSubmittedWorkDone().then(release, release);
    }
  }

  private writeQueryEntry(data: Float32Array, index: number, entry: ColliderQueryEntry): void {
    const base = index * QUERY_FLOATS;
    const field = entry.field;
    const size = field.bounds.getSize(new THREE.Vector3());
    const offset = this.offsets.get(field)!;

    data.set(entry.inverse.elements, base + QUERY_LAYOUT.inverse * 4);
    data.set(entry.motion.elements, base + QUERY_LAYOUT.motion * 4);
    data.set([...field.bounds.min.toArray(), entry.inverted ? 1 : 0], base + QUERY_LAYOUT.minimum * 4);
    data.set([...size.toArray(), field.resolution], base + QUERY_LAYOUT.extent * 4);
    data.set([...offset.toArray(), 0], base + QUERY_LAYOUT.atlasOffset * 4);
  }

  /** Constant-size shader body; collider ordering and last-hit wall velocity match individual sampling. */
  createQuery(dt: Node<'float'>): ColliderQuery {
    const parameters = this.queryStorage!,
      count = this.queryCount,
      simulationToWorld = this.simulationToWorld;
    const texture = this.texture!,
      size = vec3(this.size.clone());
    return Fn(([position]: [Node<'vec3'>]) => {
      const occupied = float(0).toVar(),
        velocity = vec3(0).toVar();
      // Freeze quadrature coordinates before the inner loop introduces its own iterator.
      const p = vec4(position, 1).toVar(),
        world = simulationToWorld.mul(p).toVar();
      Loop({ start: 0, end: count, type: 'uint', condition: '<' }, ({ i }) => {
        const base = i.mul(QUERY_VECTORS);
        const inverse = mat4(
          parameters.element(base),
          parameters.element(base.add(1)),
          parameters.element(base.add(2)),
          parameters.element(base.add(3)),
        );
        const local = inverse.mul(world).xyz;
        const minimum = parameters.element(base.add(QUERY_LAYOUT.minimum)),
          shape = parameters.element(base.add(QUERY_LAYOUT.extent));
        const uv = local.sub(minimum.xyz).div(shape.xyz).toVar();
        const hit = minimum.w.toVar();
        If(uv.greaterThanEqual(0).all().and(uv.lessThanEqual(1).all()), () => {
          // Use the same field-to-atlas normalization order as individual field sampling.
          const localTexel = uv.clamp(0, 1).mul(shape.w.sub(1)).add(0.5).div(shape.w);
          const texel = localTexel
            .mul(shape.w)
            .add(parameters.element(base.add(QUERY_LAYOUT.atlasOffset)).xyz)
            .div(size);
          hit.assign(texture3D(texture, texel).r);
        });
        occupied.assign(max(occupied, hit));
        If(hit.greaterThan(0), () => {
          const motionBase = base.add(QUERY_LAYOUT.motion);
          const motion = mat4(
            parameters.element(motionBase),
            parameters.element(motionBase.add(1)),
            parameters.element(motionBase.add(2)),
            parameters.element(motionBase.add(3)),
          );
          const previous = motion.mul(p).xyz;
          velocity.assign(p.xyz.sub(previous).div(dt));
        });
      });
      return vec4(velocity, occupied);
    });
  }

  sampler(field: FluidColliderField): ((uv: Node<'vec3'>) => Node<'float'>) | undefined {
    const texture = this.texture,
      offset = this.offsets.get(field);
    if (!texture || !offset) return;
    const size = this.size.clone();
    return uv => texture3D(texture, uv.mul(field.resolution).add(vec3(offset)).div(vec3(size))).r;
  }

  dispose(): void {
    const texture = this.texture,
      queries = this.queryAttribute;
    this.queryAttribute = undefined;
    this.queryStorage = undefined;
    this.queryVersion++;
    this.texture = undefined;
    this.fields = [];
    this.offsets.clear();
    // In-flight dispatches may still reference the previous scene's atlas.
    if (this.renderer && (texture || queries)) {
      const release = () => {
        texture?.dispose();
        queries?.dispose();
      };
      void this.device.queue.onSubmittedWorkDone().then(release, release);
    }
    this.renderer = undefined;
  }
}
