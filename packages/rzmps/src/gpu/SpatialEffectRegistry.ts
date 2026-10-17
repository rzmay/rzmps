import * as THREE from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Break, float, If, int, Loop, storage, uint, uniform } from 'three/tsl';
import SpatialEffect from '../SpatialEffect';
import type { GPUParticleLike, GPUParticleUpdateContext } from './Particle';
import type ParticleSystem from '../ParticleSystem';

export type GPUSpatialParameterType = 'float' | 'vec3' | 'vec4';

export interface GPUSpatialParameterField {
  name: string;
  type: GPUSpatialParameterType;
}

export interface GPUSpatialParameterLayout {
  id: string;
  fields: GPUSpatialParameterField[];
}

export interface GPUSpatialParameterAccessor {
  float(name: string): Node<'float'>;
  vec3(name: string): Node<'vec3'>;
  vec4(name: string): Node<'vec4'>;
}

export interface GPUSpatialEffectType {
  key?: string;
  compilationKey?: string;
  parameterLayout: GPUSpatialParameterLayout;
  testGPU(
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
    params: GPUSpatialParameterAccessor,
  ): Node<'float'>;
  modifyGPU(
    particle: GPUParticleLike,
    deltaTime: Node<'float'>,
    context: GPUParticleUpdateContext,
    params: GPUSpatialParameterAccessor,
    strength: Node<'float'>,
  ): void;
}

export interface GPUSpatialBatchableEffect {
  gpuSpatialType?: GPUSpatialEffectType;
  writeGPUParameters?: (target: Float32Array, offset: number, system: ParticleSystem) => void;
}

export interface GPUSpatialEffectRecord {
  id: number;
  typeId: number;
  parameterOffset: number;
  priority: number;
  order: number;
  tagMask: number;
  enabled: boolean;
  segmentId: number;
  bounds: THREE.Box3;
  effect: SpatialEffect;
}

export interface GPUSpatialBVHNodeRecord {
  bounds: THREE.Box3;
  left: number;
  right: number;
  start: number;
  count: number;
  escape: number;
}

export interface GPUSpatialEffectRegistryBuild {
  records: GPUSpatialEffectRecord[];
  types: GPUSpatialEffectType[];
  bvhNodes: GPUSpatialBVHNodeRecord[];
  leafEffectIds: number[];
  parameterData: Float32Array;
  metadataData: Uint32Array;
  bvhBoundsData: Float32Array;
  bvhNodeData: Int32Array;
}

type PackedFloatStorage = { element(index: Node | number): Node<'vec4'> };
type PackedUintStorage = { element(index: Node | number): Node<'uvec4'> };
type PackedIntStorage = { element(index: Node | number): Node<'ivec4'> };
type PackedScalarUintStorage = { element(index: Node | number): Node<'uint'> };

export class GPUSpatialEffectRegistry {
  private static nextVersion = 1;

  readonly parameterAttribute: StorageBufferAttribute;
  readonly metadataAttribute: StorageBufferAttribute;
  readonly bvhBoundsAttribute: StorageBufferAttribute;
  readonly bvhNodeAttribute: StorageBufferAttribute;
  readonly leafAttribute: StorageBufferAttribute;

  readonly records: GPUSpatialEffectRecord[];
  readonly types: GPUSpatialEffectType[];
  readonly bvhNodes: GPUSpatialBVHNodeRecord[];
  readonly leafEffectIds: number[];
  readonly signature: string;
  readonly version: number;

  private readonly bvhNodeCountNode = uniform(0, 'uint');

  private readonly recordByEffect = new WeakMap<SpatialEffect, GPUSpatialEffectRecord>();

  constructor(build: GPUSpatialEffectRegistryBuild) {
    this.records = build.records;
    this.types = build.types;
    this.bvhNodes = build.bvhNodes;
    this.leafEffectIds = build.leafEffectIds;
    this.signature = createSignature(build.types);
    this.version = GPUSpatialEffectRegistry.nextVersion;
    GPUSpatialEffectRegistry.nextVersion += 1;
    this.parameterAttribute = new StorageBufferAttribute(
      reserveFloat32(build.parameterData, 256),
      4,
    );
    this.metadataAttribute = new StorageBufferAttribute(
      reserveUint32(build.metadataData, 64 * 4),
      4,
    );
    this.bvhBoundsAttribute = new StorageBufferAttribute(
      reserveFloat32(build.bvhBoundsData, 64 * 8),
      4,
    );
    this.bvhNodeAttribute = new StorageBufferAttribute(
      reserveInt32(build.bvhNodeData, 64 * 4),
      4,
    );
    this.leafAttribute = new StorageBufferAttribute(
      reserveUint32(new Uint32Array(build.leafEffectIds), 64),
      1,
    );
    this.bvhNodeCountNode.value = build.bvhNodes.length;
    this.records.forEach((record) => {
      this.recordByEffect.set(record.effect, record);
    });
  }

  static build(
    effects: SpatialEffect[],
    system: ParticleSystem,
    tagMaskForEffect: (effect: SpatialEffect) => number,
  ): GPUSpatialEffectRegistry {
    return new GPUSpatialEffectRegistry(
      GPUSpatialEffectRegistry.createBuild(effects, system, tagMaskForEffect),
    );
  }

  update(
    effects: SpatialEffect[],
    system: ParticleSystem,
    tagMaskForEffect: (effect: SpatialEffect) => number,
  ): boolean {
    const build = GPUSpatialEffectRegistry.createBuild(effects, system, tagMaskForEffect);
    if (
      createSignature(build.types) !== this.signature
      || build.parameterData.length > this.parameterAttribute.array.length
      || build.metadataData.length > this.metadataAttribute.array.length
      || build.bvhBoundsData.length > this.bvhBoundsAttribute.array.length
      || build.bvhNodeData.length > this.bvhNodeAttribute.array.length
      || build.leafEffectIds.length > this.leafAttribute.array.length
    ) return false;

    replaceArrayContents(this.parameterAttribute.array as Float32Array, build.parameterData);
    replaceArrayContents(this.metadataAttribute.array as Uint32Array, build.metadataData);
    replaceArrayContents(this.bvhBoundsAttribute.array as Float32Array, build.bvhBoundsData);
    replaceArrayContents(this.bvhNodeAttribute.array as Int32Array, build.bvhNodeData);
    replaceArrayContents(this.leafAttribute.array as Uint32Array, new Uint32Array(build.leafEffectIds));
    this.parameterAttribute.needsUpdate = true;
    this.metadataAttribute.needsUpdate = true;
    this.bvhBoundsAttribute.needsUpdate = true;
    this.bvhNodeAttribute.needsUpdate = true;
    this.leafAttribute.needsUpdate = true;

    this.records.splice(0, this.records.length, ...build.records);
    this.types.splice(0, this.types.length, ...build.types);
    this.bvhNodes.splice(0, this.bvhNodes.length, ...build.bvhNodes);
    this.leafEffectIds.splice(0, this.leafEffectIds.length, ...build.leafEffectIds);
    this.bvhNodeCountNode.value = build.bvhNodes.length;
    this.records.forEach((record) => this.recordByEffect.set(record.effect, record));
    return true;
  }

  private static createBuild(
    effects: SpatialEffect[],
    system: ParticleSystem,
    tagMaskForEffect: (effect: SpatialEffect) => number,
  ): GPUSpatialEffectRegistryBuild {
    const sortedEffects = effects
      .map((effect, order) => ({ effect, order }))
      .filter(({ effect }) => isBatchableEffect(effect))
      .sort((a, b) => (a.effect.priority - b.effect.priority) || (a.order - b.order));
    const types: GPUSpatialEffectType[] = [];
    const typeIds = new Map<string, number>();
    const records: GPUSpatialEffectRecord[] = [];
    const parameterValues: number[] = [];

    sortedEffects.forEach(({ effect, order }) => {
      const batchable = effect as SpatialEffect & GPUSpatialBatchableEffect;
      const type = batchable.gpuSpatialType!;
      const typeKey = getTypeKey(type);
      let typeId = typeIds.get(typeKey);

      if (typeId === undefined) {
        typeId = types.length;
        typeIds.set(typeKey, typeId);
        types.push(type);
      }

      const parameterOffset = alignVec4(parameterValues.length);
      while (parameterValues.length < parameterOffset) parameterValues.push(0);
      const parameterSize = getLayoutFloatSize(type.parameterLayout);
      const parameterTarget = new Float32Array(parameterSize);
      batchable.writeGPUParameters?.(parameterTarget, 0, system);
      parameterValues.push(...parameterTarget);
      while (parameterValues.length % 4 !== 0) parameterValues.push(0);

      records.push({
        id: records.length,
        typeId,
        parameterOffset,
        priority: effect.priority,
        order,
        tagMask: tagMaskForEffect(effect),
        enabled: effect.visible,
        segmentId: -1,
        bounds: getEffectWorldBounds(effect, system),
        effect,
      });
    });

    const { nodes, leafEffectIds } = buildBVH(records);

    return {
      records,
      types,
      bvhNodes: nodes,
      leafEffectIds,
      parameterData: new Float32Array(parameterValues.length > 0 ? parameterValues : [0, 0, 0, 0]),
      metadataData: packMetadata(records),
      bvhBoundsData: packBVHBounds(nodes),
      bvhNodeData: packBVHNodes(nodes),
    };
  }

  getRecord(effect: SpatialEffect): GPUSpatialEffectRecord | undefined {
    return this.recordByEffect.get(effect);
  }

  configureSegments(modifierLists: Array<Array<SpatialEffect | { priority: number }>>): void {
    this.records.forEach((record) => { record.segmentId = -1; });
    let segmentId = 0;

    modifierLists.forEach((modifiers) => {
      let inSegment = false;
      modifiers.forEach((modifier) => {
        const record = modifier instanceof SpatialEffect && isBatchableEffect(modifier)
          ? this.getRecord(modifier)
          : undefined;
        if (!record) {
          inSegment = false;
          return;
        }
        if (!inSegment) {
          segmentId += 1;
          inSegment = true;
        }
        record.segmentId = segmentId;
      });
    });

    const packed = packMetadata(this.records);
    replaceArrayContents(this.metadataAttribute.array as Uint32Array, packed);
    this.metadataAttribute.needsUpdate = true;
  }

  createParameterAccessor(type: GPUSpatialEffectType, parameterOffset: Node<'uint'>): GPUSpatialParameterAccessor {
    const parameterStorage = storage(
      this.parameterAttribute,
      'vec4',
      this.parameterAttribute.count,
    ) as PackedFloatStorage;
    const fieldOffsets = getLayoutFieldOffsets(type.parameterLayout);

    const loadVec4 = (fieldOffset: number): Node<'vec4'> => {
      const vec4Offset = parameterOffset
        .div(uint(4))
        .add(uint(Math.floor(fieldOffset / 4)));
      return parameterStorage.element(vec4Offset);
    };

    const component = (fieldOffset: number): Node<'float'> => {
      const value = loadVec4(fieldOffset);
      switch (fieldOffset % 4) {
        case 0: return value.x;
        case 1: return value.y;
        case 2: return value.z;
        default: return value.w;
      }
    };

    return {
      float(name) {
        const fieldOffset = fieldOffsets.get(name);
        if (fieldOffset === undefined) throw new Error(`Unknown GPU spatial parameter "${name}".`);
        return component(fieldOffset);
      },
      vec3(name) {
        const fieldOffset = fieldOffsets.get(name);
        if (fieldOffset === undefined) throw new Error(`Unknown GPU spatial parameter "${name}".`);
        if (fieldOffset % 4 !== 0) {
          throw new Error(`GPU spatial vec3 parameter "${name}" is not vec4 aligned.`);
        }
        return loadVec4(fieldOffset).xyz;
      },
      vec4(name) {
        const fieldOffset = fieldOffsets.get(name);
        if (fieldOffset === undefined) throw new Error(`Unknown GPU spatial parameter "${name}".`);
        if (fieldOffset % 4 !== 0) {
          throw new Error(`GPU spatial vec4 parameter "${name}" is not vec4 aligned.`);
        }
        return loadVec4(fieldOffset);
      },
    };
  }

  applySegment(
    segmentId: number,
    particle: GPUParticleLike,
    context: GPUParticleUpdateContext,
  ): void {
    if (this.bvhNodes.length === 0) return;

    const metadata = storage(this.metadataAttribute, 'uvec4', this.metadataAttribute.count) as PackedUintStorage;
    const bounds = storage(this.bvhBoundsAttribute, 'vec4', this.bvhBoundsAttribute.count) as PackedFloatStorage;
    const nodes = storage(this.bvhNodeAttribute, 'ivec4', this.bvhNodeAttribute.count) as PackedIntStorage;
    const leaves = storage(this.leafAttribute, 'uint', this.leafAttribute.count) as PackedScalarUintStorage;
    const nodeIndex = int(0).toVar('spatialBVHNode');

    Loop({ start: 0, end: this.bvhNodeAttribute.count, type: 'int' }, () => {
      If(nodeIndex.greaterThanEqual(int(this.bvhNodeCountNode)), () => Break());
      const node = nodes.element(nodeIndex);
      const minimum = bounds.element(nodeIndex.mul(2));
      const maximum = bounds.element(nodeIndex.mul(2).add(1));
      const contains = particle.position.x.greaterThanEqual(minimum.x)
        .and(particle.position.y.greaterThanEqual(minimum.y))
        .and(particle.position.z.greaterThanEqual(minimum.z))
        .and(particle.position.x.lessThanEqual(maximum.x))
        .and(particle.position.y.lessThanEqual(maximum.y))
        .and(particle.position.z.lessThanEqual(maximum.z));

      If(contains, () => {
        If(node.z.greaterThan(int(0)), () => {
          Loop({ start: 0, end: 4, type: 'int' }, ({ i }) => {
            If(i.lessThan(node.z), () => {
              const effectId = leaves.element(uint(node.y.add(i)));
              const effect = metadata.element(effectId);
              If(effect.w.shiftRight(uint(1)).equal(uint(segmentId)), () => {
                const tagMatch = effect.z.equal(uint(0))
                  .or(particle.tagMask.bitAnd(effect.z).notEqual(uint(0)));
                If(effect.w.bitAnd(uint(1)).notEqual(uint(0)).and(tagMatch), () => {
                  this.types.forEach((type, typeId) => {
                    If(effect.x.equal(uint(typeId)), () => {
                      const params = this.createParameterAccessor(type, effect.y);
                      const strength = type.testGPU(particle, context, params);
                      If(strength.greaterThan(float(0)), () => {
                        type.modifyGPU(particle, context.deltaTimeNode, context, params, strength);
                      });
                    });
                  });
                });
              });
            });
          });
        });
        nodeIndex.addAssign(int(1));
      }).Else(() => {
        nodeIndex.assign(node.x);
      });
    });
  }
}

export function isBatchableEffect(effect: SpatialEffect): effect is SpatialEffect & GPUSpatialBatchableEffect {
  const candidate = effect as SpatialEffect & GPUSpatialBatchableEffect;
  return effect.supportsGPU && Boolean(
    candidate.gpuSpatialType?.testGPU
    && candidate.writeGPUParameters,
  );
}

function getTypeKey(type: GPUSpatialEffectType): string {
  return [
    type.key ?? 'anonymous',
    type.compilationKey ?? 'default',
    `test:${getObjectId(type.testGPU)}`,
    `modify:${getObjectId(type.modifyGPU)}`,
    type.parameterLayout.id,
    type.parameterLayout.fields.map((field) => `${field.name}:${field.type}`).join(','),
  ].join('|');
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function getObjectId(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId;
    nextObjectId += 1;
    objectIds.set(value, id);
  }
  return id;
}

function getLayoutFloatSize(layout: GPUSpatialParameterLayout): number {
  const offsets = getLayoutFieldOffsets(layout);
  return layout.fields.reduce((size, field) => {
    const offset = offsets.get(field.name) ?? 0;
    return Math.max(size, offset + (field.type === 'vec3' || field.type === 'vec4' ? 4 : 1));
  }, 0);
}

function getLayoutFieldOffsets(layout: GPUSpatialParameterLayout): Map<string, number> {
  const offsets = new Map<string, number>();
  let offset = 0;

  layout.fields.forEach((field) => {
    if (field.type === 'vec3' || field.type === 'vec4') offset = alignVec4(offset);
    offsets.set(field.name, offset);
    offset += field.type === 'vec3' || field.type === 'vec4' ? 4 : 1;
  });

  return offsets;
}

function alignVec4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function getEffectWorldBounds(effect: SpatialEffect, system: ParticleSystem): THREE.Box3 {
  effect.updateWorldMatrix(true, false);
  const geometry = effect.geometry;

  if (!geometry) {
    const center = effect.getWorldPosition(new THREE.Vector3());
    const radius = Math.max(effect.feather, Number.EPSILON);
    return new THREE.Box3(center.clone().subScalar(radius), center.clone().addScalar(radius));
  }

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const local = geometry.boundingBox
    ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const world = new THREE.Box3();
  const corner = new THREE.Vector3();

  for (let x = 0; x <= 1; x += 1) {
    for (let y = 0; y <= 1; y += 1) {
      for (let z = 0; z <= 1; z += 1) {
        corner.set(
          x === 0 ? local.min.x : local.max.x,
          y === 0 ? local.min.y : local.max.y,
          z === 0 ? local.min.z : local.max.z,
        );
        world.expandByPoint(corner.applyMatrix4(effect.matrixWorld));
      }
    }
  }

  world.expandByScalar(Math.max(effect.feather, Number.EPSILON));
  if (system.simulationSpace === 'local') {
    system.updateWorldMatrix(true, false);
    const inverse = system.matrixWorld.clone().invert();
    return transformBounds(world, inverse);
  }

  return world;
}

function transformBounds(bounds: THREE.Box3, matrix: THREE.Matrix4): THREE.Box3 {
  const transformed = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (let x = 0; x <= 1; x += 1) {
    for (let y = 0; y <= 1; y += 1) {
      for (let z = 0; z <= 1; z += 1) {
        corner.set(
          x === 0 ? bounds.min.x : bounds.max.x,
          y === 0 ? bounds.min.y : bounds.max.y,
          z === 0 ? bounds.min.z : bounds.max.z,
        );
        transformed.expandByPoint(corner.applyMatrix4(matrix));
      }
    }
  }
  return transformed;
}

function buildBVH(records: GPUSpatialEffectRecord[]): {
  nodes: GPUSpatialBVHNodeRecord[];
  leafEffectIds: number[];
} {
  const nodes: GPUSpatialBVHNodeRecord[] = [];
  const leafEffectIds: number[] = [];
  const indexed = records.map((record) => record.id);

  const buildNode = (ids: number[]): number => {
    const index = nodes.length;
    const bounds = ids.reduce(
      (box, id) => box.union(records[id].bounds),
      new THREE.Box3(),
    );

    nodes.push({ bounds, left: -1, right: -1, start: -1, count: 0, escape: -1 });

    if (ids.length <= 4) {
      nodes[index].start = leafEffectIds.length;
      nodes[index].count = ids.length;
      leafEffectIds.push(...ids);
      return index;
    }

    const size = bounds.getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    void axis;
    const middle = Math.ceil(ids.length / 2);

    nodes[index].left = buildNode(ids.slice(0, middle));
    nodes[index].right = buildNode(ids.slice(middle));
    return index;
  };

  if (indexed.length > 0) buildNode(indexed);
  nodes.forEach((node, index) => {
    node.escape = index + subtreeSize(nodes, index);
  });

  return { nodes, leafEffectIds };
}

function subtreeSize(nodes: GPUSpatialBVHNodeRecord[], index: number): number {
  const node = nodes[index];
  if (!node || node.left < 0) return 1;
  return 1 + subtreeSize(nodes, node.left) + subtreeSize(nodes, node.right);
}

function packMetadata(records: GPUSpatialEffectRecord[]): Uint32Array {
  const data = new Uint32Array(Math.max(records.length, 1) * 4);
  records.forEach((record, index) => {
    const offset = index * 4;
    data[offset] = record.typeId;
    data[offset + 1] = record.parameterOffset;
    data[offset + 2] = record.tagMask;
    data[offset + 3] = (Math.max(record.segmentId, 0) << 1) | (record.enabled ? 1 : 0);
  });
  return data;
}

function packBVHBounds(nodes: GPUSpatialBVHNodeRecord[]): Float32Array {
  const data = new Float32Array(Math.max(nodes.length, 1) * 8);
  nodes.forEach((node, index) => {
    const offset = index * 8;
    data.set([
      node.bounds.min.x,
      node.bounds.min.y,
      node.bounds.min.z,
      0,
      node.bounds.max.x,
      node.bounds.max.y,
      node.bounds.max.z,
      0,
    ], offset);
  });
  return data;
}

function packBVHNodes(nodes: GPUSpatialBVHNodeRecord[]): Int32Array {
  const data = new Int32Array(Math.max(nodes.length, 1) * 4);
  nodes.forEach((node, index) => {
    const offset = index * 4;
    data[offset] = node.escape;
    data[offset + 1] = node.start;
    data[offset + 2] = node.count;
    data[offset + 3] = 0;
  });
  return data;
}

function createSignature(types: GPUSpatialEffectType[]): string {
  return `types:${types.map(getTypeKey).join(';')}`;
}

function reservedLength(required: number, minimum: number): number {
  let capacity = Math.max(1, minimum);
  while (capacity < required * 2) capacity *= 2;
  return capacity;
}

function reserveFloat32(source: Float32Array, minimum: number): Float32Array {
  const target = new Float32Array(reservedLength(source.length, minimum));
  target.set(source);
  return target;
}

function reserveUint32(source: Uint32Array, minimum: number): Uint32Array {
  const target = new Uint32Array(reservedLength(source.length, minimum));
  target.set(source);
  return target;
}

function reserveInt32(source: Int32Array, minimum: number): Int32Array {
  const target = new Int32Array(reservedLength(source.length, minimum));
  target.set(source);
  return target;
}

function replaceArrayContents<T extends Float32Array | Uint32Array | Int32Array>(
  target: T,
  source: T,
): void {
  target.fill(0);
  target.set(source);
}
