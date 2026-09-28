import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { float, hash, int, mix, uniformArray, vec3 } from 'three/tsl';
import ParticleSystem from '../ParticleSystem';
import type { DynamicValue } from '../types/DynamicValue';
import evaluateDynamicNumber from './evaluateDynamicNumber';
import evaluateDynamicVector from './evaluateDynamicVector3';
import evaluateDynamicColor from './evaluateDynamicColor';
import isTSLNode from './isTSLNode';

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
