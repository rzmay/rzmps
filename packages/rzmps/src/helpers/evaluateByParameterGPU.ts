import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { float, int, mix, uniformArray, vec3 } from 'three/tsl';
import ParticleSystem from '../ParticleSystem';
import type { ValueByParameter } from '../types/ValueByParameter';
import evaluateByParameterNumber from './evaluateByParameterNumber';
import evaluateByParameterVector from './evaluateByParameterVector3';
import evaluateByParameterColor from './evaluateByParameterColor';
import isTSLNode from './isTSLNode';

export function evaluateByParameterNumberGPU(
  value: ValueByParameter<number> | undefined,
  parameter: Node<'float'>,
  fallback = 0,
): Node<'float'> {
  if (value === undefined) return float(fallback);
  if (isTSLNode(value)) return value as Node<'float'>;
  if (typeof value === 'function') return sampleParameterNumberGPU(value, parameter);
  if (typeof value === 'number') return float(value).mul(parameter);
  if (Array.isArray(value)) {
    return mix(
      evaluateByParameterNumberGPU(value[0], parameter, fallback),
      evaluateByParameterNumberGPU(value[1], parameter, fallback),
      parameter.clamp(0, 1),
    );
  }
  throw new Error('GPU parameter values must be constants or [constant, constant] ranges.');
}

export function evaluateByParameterVectorGPU(
  value: ValueByParameter<THREE.Vector3> | undefined,
  parameter: Node<'float'>,
  fallback = new THREE.Vector3(),
): Node<'vec3'> {
  if (value === undefined) return vec3(fallback).mul(parameter);
  if (isTSLNode(value)) return value as Node<'vec3'>;
  if (typeof value === 'function') return sampleParameterVectorGPU(value, parameter);
  if (value instanceof THREE.Vector3) return vec3(value).mul(parameter);
  if (Array.isArray(value)) {
    return mix(
      evaluateByParameterVectorGPU(value[0], parameter, fallback),
      evaluateByParameterVectorGPU(value[1], parameter, fallback),
      parameter.clamp(0, 1),
    );
  }
  throw new Error('GPU parameter vectors must be constants or [constant, constant] ranges.');
}

export function evaluateByParameterColorGPU(
  value: ValueByParameter<THREE.Color> | undefined,
  parameter: Node<'float'>,
  fallback = new THREE.Color(),
): Node<'vec3'> {
  if (value === undefined) return vec3(fallback.r, fallback.g, fallback.b).mul(parameter);
  if (isTSLNode(value)) return value as Node<'vec3'>;
  if (typeof value === 'function') return sampleParameterColorGPU(value, parameter);
  if (value instanceof THREE.Color) return vec3(value.r, value.g, value.b).mul(parameter);
  if (Array.isArray(value)) {
    return mix(
      evaluateByParameterColorGPU(value[0], parameter, fallback),
      evaluateByParameterColorGPU(value[1], parameter, fallback),
      parameter.clamp(0, 1),
    );
  }
  throw new Error('GPU parameter colors must be constants or [constant, constant] ranges.');
}

function sampleParameterNumberGPU(
  value: ValueByParameter<number>,
  parameter: Node<'float'>,
): Node<'float'> {
  return sampleNumberArrayGPU(
    sampleParameterValue(value, evaluateByParameterNumber),
    parameter,
  );
}

function sampleParameterVectorGPU(
  value: ValueByParameter<THREE.Vector3>,
  parameter: Node<'float'>,
): Node<'vec3'> {
  return sampleVectorArrayGPU(
    sampleParameterValue(value, evaluateByParameterVector),
    parameter,
  );
}

function sampleParameterColorGPU(
  value: ValueByParameter<THREE.Color>,
  parameter: Node<'float'>,
): Node<'vec3'> {
  const samples = sampleParameterValue(value, evaluateByParameterColor)
    .map((sample) => new THREE.Vector3(sample.r, sample.g, sample.b));
  return sampleVectorArrayGPU(samples, parameter);
}

function sampleParameterValue<T>(
  value: ValueByParameter<T>,
  evaluate: (value: ValueByParameter<T>, parameter: number) => T,
): T[] {
  const resolution = Math.max(2, Math.floor(ParticleSystem.GPU_DYNAMIC_VALUE_RESOLUTION));
  return Array.from({ length: resolution }, (_unused, index) => {
    const parameter = index / (resolution - 1);
    return evaluate(value, parameter);
  });
}

function sampleNumberArrayGPU(
  samples: number[],
  parameter: Node<'float'>,
): Node<'float'> {
  const resolution = samples.length;
  const samplePosition = parameter.clamp(0, 1).mul(resolution - 1);
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
  parameter: Node<'float'>,
): Node<'vec3'> {
  const resolution = samples.length;
  const samplePosition = parameter.clamp(0, 1).mul(resolution - 1);
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
