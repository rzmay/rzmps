import { MathUtils, Vector3 } from 'three';
import volumeNumber from './volumeNumber';
import seedrandom from 'seedrandom';
import type { RendererChildrenOptions } from '../core/Renderer';
import evaluateDynamicNumber from '../values/evaluateDynamicNumber';
import evaluateByParameterNumber from '../values/evaluateByParameterNumber';
import evaluateByParameterVector3 from '../values/evaluateByParameterVector3';
import type { ValueByParameter } from '../values/valueByParameter.types';

export interface VolumeCopy {
  offset: Vector3;
  rotation: Vector3;
  scale: number;
  alpha: number;
}

/** A deterministic field-reuse stencil, not additional simulated particles or a new density grid. */
export default function volumeChildren(options: RendererChildrenOptions, seed: string): VolumeCopy[] {
  const value = evaluateDynamicNumber(volumeNumber(options.count ?? 0), 0, `${seed}:count`);
  if (!Number.isFinite(value)) throw new RangeError('Volume child count must be finite.');
  const count = Math.max(0, Math.floor(value));
  const radius = Math.max(0, evaluateDynamicNumber(volumeNumber(options.radius ?? 0), 0, `${seed}:radius`));
  const copies: VolumeCopy[] = [];
  for (let i = 0; i < count; i++) {
    const random = seedrandom.tychei(`${seed}[${i}]`);
    const distance = Math.cbrt(random.quick());
    const offset = new Vector3().setFromSphericalCoords(
      distance * radius,
      Math.acos(2 * random.quick() - 1),
      random.quick() * Math.PI * 2,
    );
    const scaleVariation = random.quick() - 0.5;
    const alphaVariation = random.quick() - 0.5;
    const rotationVariation = random.quick() - 0.5;

    const sample = (key: 'scale' | 'alpha', variation: number) => {
      let t = MathUtils.clamp(
        (radius > 0 ? distance : 0) + (options[key === 'scale' ? 'randomizeScale' : 'randomizeAlpha'] ?? 0) * variation,
        0,
        1,
      );
      if (options.radialFalloff) t = options.radialFalloff(t);
      const curve = volumeNumber(options[key] ?? 1) as ValueByParameter<number>;
      return typeof curve === 'number' ? curve : evaluateByParameterNumber(curve, t);
    };

    const scale = sample('scale', scaleVariation);
    const alpha = sample('alpha', alphaVariation);
    if (!Number.isFinite(scale) || !Number.isFinite(alpha)) {
      throw new RangeError('Volume child scale and alpha must be finite.');
    }

    // Rotation uses the same radial parameter convention as particle-renderer children.
    let t = MathUtils.clamp((radius > 0 ? distance : 0) + (options.randomizeRotation ?? 0) * rotationVariation, 0, 1);
    if (options.radialFalloff) t = options.radialFalloff(t);
    const value = options.rotation ?? 0;
    const rotation = evaluateByParameterVector3(
      typeof value === 'number' || value instanceof Vector3 ? [value, value] : value,
      t,
    );
    if (![rotation.x, rotation.y, rotation.z].every(Number.isFinite)) {
      throw new RangeError('Volume child rotation must be finite.');
    }
    if (scale > 0 && alpha > 0) copies.push({ offset, rotation, scale, alpha });
  }
  return copies;
}
