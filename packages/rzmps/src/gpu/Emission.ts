import type EmissionShape from '../EmissionShape';
import type Emitter from '../Emitter';
import { EmissionSource } from '../enums/EmissionSource';
import { TagSelectionMethod } from '../enums/TagSelectionMethod';

export type GPUEmissionSupportLevel = 'native' | 'cpu-only' | 'unsupported';

export interface GPUEmissionSupportReport {
  supported: boolean;
  level: GPUEmissionSupportLevel;
  reasons: string[];
  features: string[];
}

export function getGPUEmissionShapeSupport(shape: EmissionShape): GPUEmissionSupportReport {
  const reasons: string[] = [];
  const features: string[] = [];
  const geometryType = shape.geometry.type;

  switch (geometryType) {
    case 'BoxGeometry':
    case 'SphereGeometry':
    case 'ConeGeometry':
    case 'TorusGeometry':
      features.push(`${geometryType}:${shape.source}`);
      break;
    default:
      reasons.push(`Emission shape geometry '${geometryType}' requires a GPU sampling table before it can emit natively.`);
  }

  if (
    shape.source !== EmissionSource.Volume
    && shape.source !== EmissionSource.Surface
    && shape.source !== EmissionSource.Vertices
  ) {
    reasons.push(`Emission source '${shape.source}' is not recognized by the GPU emission audit.`);
  }

  return {
    supported: reasons.length === 0,
    level: reasons.length === 0 ? 'native' : 'unsupported',
    reasons,
    features,
  };
}

export function getGPUEmitterSupport(emitter: Emitter): GPUEmissionSupportReport {
  if (emitter.emitGPU) {
    return {
      supported: true,
      level: 'native',
      reasons: [],
      features: ['customEmitGPU'],
    };
  }

  const shapeReport = getGPUEmissionShapeSupport(emitter.source);
  const reasons = [...shapeReport.reasons];
  const features = [...shapeReport.features];

  features.push('rate', 'rateOverDistance', 'radialSpeed', 'alignment');
  if (emitter.bursts.length > 0) features.push('bursts');
  features.push('initialValues');

  if (emitter.tags?.length) {
    if (emitter.tagSelection === TagSelectionMethod.All) {
      features.push('tags:all');
    } else if (emitter.tagSelection === TagSelectionMethod.Random) {
      features.push('tags:random');
    } else if (emitter.tagSelection === TagSelectionMethod.Distribute) {
      reasons.push('Distributed tag selection requires persistent per-emitter GPU context state.');
    } else {
      reasons.push(`Tag selection '${emitter.tagSelection}' is not recognized by the GPU emission audit.`);
    }
  }

  if (emitter.useUpdateLOD) features.push('updateLOD');
  if (emitter.countLOD) features.push('countLOD');

  if (emitter.supportsBuiltInGPUEmission()) {
    features.push(`builtIn:${emitter.source.geometry.type}:${emitter.source.source}`);
  } else {
    reasons.push('Built-in emitter configuration is audited but does not match an implemented native GPU emission path; provide emitGPU for GPU-native execution.');
  }

  return {
    supported: reasons.length === 0,
    level: reasons.length === 0 ? 'native' : 'unsupported',
    reasons,
    features,
  };
}
