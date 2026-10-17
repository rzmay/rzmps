import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { float, hash, int, mix, uniform, uniformArray, vec3 } from 'three/tsl';
import ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from './evaluateDynamicNumber';
import evaluateDynamicVector from './evaluateDynamicVector3';
import evaluateDynamicColor from './evaluateDynamicColor';
import isTSLNode from './isTSLNode';

type DynamicKind = 'number' | 'vector' | 'color';
type DynamicParameter = DynamicValue<number> | DynamicValue<THREE.Vector3> | DynamicValue<THREE.Color> | undefined;
type DynamicGetter = () => DynamicParameter;

interface DynamicBinding {
  getter: DynamicGetter;
  source: DynamicParameter;
  node: (time: Node<'float'>, seed?: Node) => Node;
  update: (value: DynamicParameter) => DynamicBindingUpdate;
}

type DynamicBindingUpdate = false | 'unchanged' | 'updated';

/** Persistent uniform-backed dynamic values owned by one GPU-configurable component. */
export class GPUDynamicParameterStore {
  private readonly bindings = new Map<string, DynamicBinding>();
  private _version = 0;
  private _uploadCount = 0;

  get version(): number {
    return this._version;
  }

  get uploadCount(): number {
    return this._uploadCount;
  }

  sync(): boolean {
    let structuralChange = false;
    this.bindings.forEach((binding, key) => {
      const value = binding.getter();
      const update = binding.update(value);
      if (update) {
        binding.source = value;
        if (update === 'updated') this._uploadCount += 1;
        return;
      }

      this.bindings.delete(key);
      structuralChange = true;
    });

    if (structuralChange) this._version += 1;
    return structuralChange;
  }

  number(
    key: string,
    getter: () => DynamicValue<number> | undefined,
    time: Node<'float'>,
    fallback = 0,
    seed?: Node,
  ): Node<'float'> {
    return this.get(key, 'number', getter, fallback).node(time, seed) as Node<'float'>;
  }

  vector(
    key: string,
    getter: () => DynamicValue<THREE.Vector3> | undefined,
    time: Node<'float'>,
    fallback = new THREE.Vector3(),
    seed?: Node,
  ): Node<'vec3'> {
    return this.get(key, 'vector', getter, fallback).node(time, seed) as Node<'vec3'>;
  }

  color(
    key: string,
    getter: () => DynamicValue<THREE.Color> | undefined,
    time: Node<'float'>,
    fallback = new THREE.Color(),
    seed?: Node,
  ): Node<'vec3'> {
    return this.get(key, 'color', getter, fallback).node(time, seed) as Node<'vec3'>;
  }

  parameterNumber(
    key: string,
    getter: () => DynamicValue<number> | undefined,
    parameter: Node<'float'>,
    fallback = 0,
  ): Node<'float'> {
    return this.getParameter(key, 'number', getter, fallback).node(parameter) as Node<'float'>;
  }

  parameterVector(
    key: string,
    getter: () => DynamicValue<THREE.Vector3> | undefined,
    parameter: Node<'float'>,
    fallback = new THREE.Vector3(),
  ): Node<'vec3'> {
    return this.getParameter(key, 'vector', getter, fallback).node(parameter) as Node<'vec3'>;
  }

  parameterColor(
    key: string,
    getter: () => DynamicValue<THREE.Color> | undefined,
    parameter: Node<'float'>,
    fallback = new THREE.Color(),
  ): Node<'vec3'> {
    return this.getParameter(key, 'color', getter, fallback).node(parameter) as Node<'vec3'>;
  }

  private get(
    key: string,
    kind: DynamicKind,
    getter: DynamicGetter,
    fallback: number | THREE.Vector3 | THREE.Color,
  ): DynamicBinding {
    const existing = this.bindings.get(key);
    if (existing) {
      existing.getter = getter;
      return existing;
    }

    const source = getter();
    const binding = createDynamicBinding(kind, source, fallback);
    binding.getter = getter;
    this.bindings.set(key, binding);
    return binding;
  }

  private getParameter(
    key: string,
    kind: DynamicKind,
    getter: DynamicGetter,
    fallback: number | THREE.Vector3 | THREE.Color,
  ): DynamicBinding {
    const bindingKey = `parameter:${key}`;
    const existing = this.bindings.get(bindingKey);
    if (existing) {
      existing.getter = getter;
      return existing;
    }

    const source = getter();
    const binding = createParameterBinding(kind, source, fallback);
    binding.getter = getter;
    this.bindings.set(bindingKey, binding);
    return binding;
  }
}

function createParameterBinding(
  kind: DynamicKind,
  source: DynamicParameter,
  fallback: number | THREE.Vector3 | THREE.Color,
  endpoint = false,
): DynamicBinding {
  const emptyGetter = () => source;
  if (typeof source === 'function') {
    const samples = sampleByKind(kind, source);
    const samplesNode = uniformArray(samples, kind === 'number' ? 'float' : 'vec3');
    return {
      getter: emptyGetter,
      source,
      node: (parameter) => sampleUniformArray(samplesNode, samples.length, parameter, kind),
      update: (next) => {
        if (typeof next !== 'function') return false;
        return updateSamples(samples, sampleByKind(kind, next));
      },
    };
  }

  if (Array.isArray(source)) {
    const children = source.map((value) => createParameterBinding(kind, value, fallback, true));
    return {
      getter: emptyGetter,
      source,
      node: (parameter) => mix(
        children[0].node(parameter) as never,
        children[1].node(parameter) as never,
        parameter.clamp(0, 1),
      ),
      update: (next) => updateChildren(children, next),
    };
  }

  const base = createDynamicBinding(kind, source, fallback);
  return {
    getter: emptyGetter,
    source,
    node: (parameter) => {
      const value = base.node(parameter);
      if (endpoint || (source === undefined && kind === 'number')) return value;
      return (value as Node<'float'>).mul(parameter) as Node;
    },
    update: (next) => base.update(next),
  };
}

function createDynamicBinding(
  kind: DynamicKind,
  source: DynamicParameter,
  fallback: number | THREE.Vector3 | THREE.Color,
): DynamicBinding {
  const emptyGetter = () => source;
  if (source === undefined) {
    const value = createUniformValue(kind, fallback);
    const valueNode = kind === 'number'
      ? uniform(value as number, 'float') as unknown as Node
      : uniform(value as THREE.Vector3, 'vec3') as unknown as Node;
    return {
      getter: emptyGetter,
      source,
      node: () => valueNode,
      update: (next) => {
        if (next !== undefined) return false;
        return updateUniformValue(valueNode, createUniformValue(kind, fallback));
      },
    };
  }

  if (isTSLNode(source)) {
    return {
      getter: emptyGetter,
      source,
      node: () => source as Node,
      update: (next) => next === source ? 'unchanged' : false,
    };
  }

  if (typeof source === 'function') {
    const samples = sampleByKind(kind, source);
    const samplesNode = uniformArray(samples, kind === 'number' ? 'float' : 'vec3');
    return {
      getter: emptyGetter,
      source,
      node: (time) => sampleUniformArray(samplesNode, samples.length, time, kind),
      update: (next) => {
        if (typeof next !== 'function') return false;
        return updateSamples(samples, sampleByKind(kind, next));
      },
    };
  }

  if (Array.isArray(source)) {
    const children = source.map((value) => createDynamicBinding(kind, value, fallback));
    return {
      getter: emptyGetter,
      source,
      node: (time, seed) => mix(
        children[0].node(time, seed) as never,
        children[1].node(time, seed) as never,
        hash(seed ?? time),
      ),
      update: (next) => updateChildren(children, next),
    };
  }

  if (source instanceof Set) {
    const values = Array.from(source as Set<DynamicParameter>);
    const children = values.map((value) => createDynamicBinding(kind, value, fallback));
    return {
      getter: emptyGetter,
      source,
      node: (time, seed) => {
        if (!children.length) return createDynamicBinding(kind, undefined, fallback).node(time, seed);
        const selected = int(hash(seed ?? time).mul(children.length).floor());
        return children.reduce<Node>((result, child, index) => (
          selected.equal(index).select(child.node(time, seed), result)
        ), createDynamicBinding(kind, undefined, fallback).node(time, seed));
      },
      update: (next) => {
        if (!(next instanceof Set) || next.size !== children.length) return false;
        return updateChildren(children, Array.from(next as Set<DynamicParameter>));
      },
    };
  }

  const value = createUniformValue(kind, source);
  const valueNode = kind === 'number'
    ? uniform(value as number, 'float') as unknown as Node
    : uniform(value as THREE.Vector3, 'vec3') as unknown as Node;
  return {
    getter: emptyGetter,
    source,
    node: () => valueNode,
    update: (next) => {
      if (!isConstantOfKind(kind, next)) return false;
      return updateUniformValue(valueNode, createUniformValue(kind, next));
    },
  };
}

function sampleByKind(kind: DynamicKind, value: DynamicParameter): Array<number | THREE.Vector3> {
  if (kind === 'number') return sampleDynamicValue(value as DynamicValue<number>, evaluateDynamicNumber);
  if (kind === 'vector') return sampleDynamicValue(value as DynamicValue<THREE.Vector3>, evaluateDynamicVector);
  return sampleDynamicValue(value as DynamicValue<THREE.Color>, evaluateDynamicColor)
    .map((sample) => new THREE.Vector3(sample.r, sample.g, sample.b));
}

function sampleUniformArray(
  samplesNode: ReturnType<typeof uniformArray>,
  resolution: number,
  time: Node<'float'>,
  kind: DynamicKind,
): Node {
  const samplePosition = time.clamp(0, 1).mul(resolution - 1);
  const lowerPosition = samplePosition.floor();
  const lowerIndex = int(lowerPosition);
  const upperIndex = int(lowerPosition.add(1).min(resolution - 1));
  return mix(
    samplesNode.element(lowerIndex) as never,
    samplesNode.element(upperIndex) as never,
    samplePosition.sub(lowerPosition),
  ) as Node;
}

function createUniformValue(
  kind: DynamicKind,
  value: DynamicParameter | number | THREE.Vector3 | THREE.Color,
): number | THREE.Vector3 {
  if (kind === 'number') return value as number;
  if (value instanceof THREE.Color) return new THREE.Vector3(value.r, value.g, value.b);
  return (value as THREE.Vector3).clone();
}

function updateUniformValue(node: Node, value: number | THREE.Vector3): DynamicBindingUpdate {
  const target = node as Node & { value: number | THREE.Vector3 };
  if (target.value instanceof THREE.Vector3 && value instanceof THREE.Vector3) {
    if (target.value.equals(value)) return 'unchanged';
    target.value.copy(value);
  } else {
    if (target.value === value) return 'unchanged';
    target.value = value;
  }
  return 'updated';
}

function updateSamples(
  target: Array<number | THREE.Vector3>,
  source: Array<number | THREE.Vector3>,
): DynamicBindingUpdate {
  let changed = false;
  source.forEach((value, index) => {
    if (target[index] instanceof THREE.Vector3 && value instanceof THREE.Vector3) {
      if (!target[index].equals(value)) {
        target[index].copy(value);
        changed = true;
      }
    } else if (target[index] !== value) {
      target[index] = value;
      changed = true;
    }
  });
  return changed ? 'updated' : 'unchanged';
}

function updateChildren(
  children: DynamicBinding[],
  next: unknown,
): DynamicBindingUpdate {
  if (!Array.isArray(next) || next.length !== children.length) return false;
  let changed = false;
  for (let index = 0; index < children.length; index += 1) {
    const update = children[index].update(next[index]);
    if (!update) return false;
    if (update === 'updated') changed = true;
  }
  return changed ? 'updated' : 'unchanged';
}

function isConstantOfKind(kind: DynamicKind, value: DynamicParameter): boolean {
  if (kind === 'number') return typeof value === 'number';
  if (kind === 'vector') return value instanceof THREE.Vector3;
  return value instanceof THREE.Color;
}

export function evaluateDynamicNumberGPU(
  value: DynamicValue<number> | undefined,
  time: Node<'float'>,
  fallback = 0,
  seed?: Node,
): Node<'float'> {
  if (value === undefined) return float(fallback);
  if (isTSLNode(value)) return value as Node<'float'>;
  if (typeof value === 'function') {
    return sampleDynamicNumberGPU(value, time);
  }
  if (typeof value === 'number') return float(value);
  if (Array.isArray(value)) {
    return mix(
      evaluateDynamicNumberGPU(value[0], time, fallback, seed),
      evaluateDynamicNumberGPU(value[1], time, fallback, seed),
      hash(seed ?? time),
    );
  }
  if (value instanceof Set) {
    return selectDynamicNumberSetGPU(value, time, fallback, seed);
  }
  throw new Error('GPU dynamic numbers must be constants or [constant, constant] ranges.');
}

export function evaluateDynamicVectorGPU(
  value: DynamicValue<THREE.Vector3> | undefined,
  time: Node<'float'>,
  fallback = new THREE.Vector3(),
  seed?: Node,
): Node<'vec3'> {
  if (value === undefined) return vec3(fallback);
  if (isTSLNode(value)) return value as Node<'vec3'>;
  if (typeof value === 'function') {
    return sampleDynamicVectorGPU(value, time);
  }
  if (value instanceof THREE.Vector3) return vec3(value);
  if (Array.isArray(value)) {
    return mix(
      evaluateDynamicVectorGPU(value[0], time, fallback, seed),
      evaluateDynamicVectorGPU(value[1], time, fallback, seed),
      hash(seed ?? time),
    );
  }
  if (value instanceof Set) {
    return selectDynamicVectorSetGPU(value, time, fallback, seed);
  }
  throw new Error('GPU dynamic vectors must be constants or [constant, constant] ranges.');
}

export function evaluateDynamicColorGPU(
  value: DynamicValue<THREE.Color> | undefined,
  time: Node<'float'>,
  fallback = new THREE.Color(),
  seed?: Node,
): Node<'vec3'> {
  if (value === undefined) return vec3(fallback.r, fallback.g, fallback.b);
  if (isTSLNode(value)) return value as Node<'vec3'>;
  if (typeof value === 'function') {
    return sampleDynamicColorGPU(value, time);
  }
  if (value instanceof THREE.Color) return vec3(value.r, value.g, value.b);
  if (Array.isArray(value)) {
    return mix(
      evaluateDynamicColorGPU(value[0], time, fallback, seed),
      evaluateDynamicColorGPU(value[1], time, fallback, seed),
      hash(seed ?? time),
    );
  }
  if (value instanceof Set) {
    return selectDynamicColorSetGPU(value, time, fallback, seed);
  }
  throw new Error('GPU dynamic colors must be constants or [constant, constant] ranges.');
}

function selectDynamicNumberSetGPU(
  value: Set<DynamicValue<number>>,
  time: Node<'float'>,
  fallback: number,
  seed?: Node,
): Node<'float'> {
  const options = Array.from(value);
  if (!options.length) return float(fallback);

  const selected = int(hash(seed ?? time).mul(options.length).floor());
  return options.reduce<Node<'float'>>((result, option, index) => (
    selected.equal(index).select(
      evaluateDynamicNumberGPU(option, time, fallback, seed),
      result,
    )
  ), float(fallback));
}

function selectDynamicVectorSetGPU(
  value: Set<DynamicValue<THREE.Vector3>>,
  time: Node<'float'>,
  fallback: THREE.Vector3,
  seed?: Node,
): Node<'vec3'> {
  const options = Array.from(value);
  if (!options.length) return vec3(fallback);

  const selected = int(hash(seed ?? time).mul(options.length).floor());
  return options.reduce<Node<'vec3'>>((result, option, index) => (
    selected.equal(index).select(
      evaluateDynamicVectorGPU(option, time, fallback, seed),
      result,
    )
  ), vec3(fallback));
}

function selectDynamicColorSetGPU(
  value: Set<DynamicValue<THREE.Color>>,
  time: Node<'float'>,
  fallback: THREE.Color,
  seed?: Node,
): Node<'vec3'> {
  const options = Array.from(value);
  if (!options.length) return vec3(fallback.r, fallback.g, fallback.b);

  const selected = int(hash(seed ?? time).mul(options.length).floor());
  return options.reduce<Node<'vec3'>>((result, option, index) => (
    selected.equal(index).select(
      evaluateDynamicColorGPU(option, time, fallback, seed),
      result,
    )
  ), vec3(fallback.r, fallback.g, fallback.b));
}

function sampleDynamicNumberGPU(
  value: DynamicValue<number>,
  time: Node<'float'>,
): Node<'float'> {
  const samples = sampleDynamicValue(value, evaluateDynamicNumber);
  return sampleNumberArrayGPU(samples, time);
}

function sampleDynamicVectorGPU(
  value: DynamicValue<THREE.Vector3>,
  time: Node<'float'>,
): Node<'vec3'> {
  const samples = sampleDynamicValue(value, evaluateDynamicVector);
  return sampleVectorArrayGPU(samples, time);
}

function sampleDynamicColorGPU(
  value: DynamicValue<THREE.Color>,
  time: Node<'float'>,
): Node<'vec3'> {
  const samples = sampleDynamicValue(value, evaluateDynamicColor)
    .map((sample) => new THREE.Vector3(sample.r, sample.g, sample.b));
  return sampleVectorArrayGPU(samples, time);
}

function sampleDynamicValue<T>(
  value: DynamicValue<T>,
  evaluate: (value: DynamicValue<T>, time: number, seed?: string) => T,
): T[] {
  const resolution = Math.max(2, Math.floor(ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION));
  return Array.from({ length: resolution }, (_unused, index) => {
    const time = index / (resolution - 1);
    return evaluate(value, time, `gpu-dynamic-${index}`);
  });
}

function sampleNumberArrayGPU(
  samples: number[],
  time: Node<'float'>,
): Node<'float'> {
  const resolution = samples.length;
  const samplePosition = time.clamp(0, 1).mul(resolution - 1);
  const lowerPosition = samplePosition.floor();
  const lowerIndex = int(lowerPosition);
  const upperIndex = int(lowerPosition.add(1).min(resolution - 1));
  const interpolation = samplePosition.sub(lowerPosition);
  const samplesNode = uniformArray(samples, 'float');
  const lower = samplesNode.element(lowerIndex) as unknown as Node<'float'>;
  const upper = samplesNode.element(upperIndex) as unknown as Node<'float'>;

  return mix(
    lower,
    upper,
    interpolation,
  );
}

function sampleVectorArrayGPU(
  samples: THREE.Vector3[],
  time: Node<'float'>,
): Node<'vec3'> {
  const resolution = samples.length;
  const samplePosition = time.clamp(0, 1).mul(resolution - 1);
  const lowerPosition = samplePosition.floor();
  const lowerIndex = int(lowerPosition);
  const upperIndex = int(lowerPosition.add(1).min(resolution - 1));
  const interpolation = samplePosition.sub(lowerPosition);
  const samplesNode = uniformArray(samples, 'vec3');
  const lower = samplesNode.element(lowerIndex) as unknown as Node<'vec3'>;
  const upper = samplesNode.element(upperIndex) as unknown as Node<'vec3'>;

  return mix(
    lower,
    upper,
    interpolation,
  );
}
