import { MathUtils, Vector3 } from 'three';
import seedrandom from 'seedrandom';
import type { RendererChildrenOptions } from '../Renderer';
import evaluateDynamicNumber from './evaluateDynamicNumber';
import evaluateByParameterNumber from './evaluateByParameterNumber';
import isTSLNode from './isTSLNode';
import type { DynamicValue } from '../types/DynamicValue';
import type { ValueByParameter } from '../types/ValueByParameter';

export interface VolumeCopy {
  offset: Vector3;
  scale: number;
  alpha: number;
}

/** Field-copy configuration is evaluated once per renderer update, not per simulated particle. */
export function volumeNumber(value: DynamicValue<number>): DynamicValue<number> {
  if (isTSLNode(value)) {
    const node = value as unknown as { value?: unknown; isVarNode?: boolean; node?: DynamicValue<number> };
    const literal = node.value;
    if (typeof literal === 'number') return literal;
    if (node.isVarNode && node.node && isTSLNode(node.node)) return volumeNumber(node.node);
    throw new Error('Volume appearance requires CPU-evaluable curves or numeric TSL constants/uniforms.');
  }
  if (typeof value === 'function') return t => volumeNumber(value(t));
  if (Array.isArray(value)) return [volumeNumber(value[0]), volumeNumber(value[1])];
  if (value instanceof Set) return new Set([...value].map(volumeNumber));
  return value;
}

/** A deterministic field-reuse stencil, not additional simulated particles or a new density grid. */
export default function volumeChildren(options: RendererChildrenOptions, seed: string): VolumeCopy[] {
  const value = evaluateDynamicNumber(volumeNumber(options.count ?? 0), 0, `${seed}:count`);
  if (!Number.isFinite(value)) throw new RangeError('Volume child count must be finite.');
  const count = Math.max(0, Math.floor(value));
  const radius = Math.max(0, options.radius ?? 0);
  const copies: VolumeCopy[] = [];
  for (let i = 0; i < count; i++) {
    const random = seedrandom.tychei(`${seed}[${i}]`);
    const distance = Math.cbrt(random.quick());
    const offset = new Vector3().setFromSphericalCoords(
      distance * radius, Math.acos(2 * random.quick() - 1), random.quick() * Math.PI * 2,
    );
    const scaleVariation = random.quick() - 0.5;
    const alphaVariation = random.quick() - 0.5;
    const sample = (key: 'scale' | 'alpha', variation: number) => {
      let t = MathUtils.clamp((radius > 0 ? distance : 0)
        + (options[key === 'scale' ? 'randomizeScale' : 'randomizeAlpha'] ?? 0) * variation, 0, 1);
      if (options.radialFalloff) t = options.radialFalloff(t);
      const curve = volumeNumber(options[key] ?? 1) as ValueByParameter<number>;
      return typeof curve === 'number' ? curve : evaluateByParameterNumber(curve, t);
    };
    const scale = sample('scale', scaleVariation);
    const alpha = sample('alpha', alphaVariation);
    if (!Number.isFinite(scale) || !Number.isFinite(alpha)) {
      throw new RangeError('Volume child scale and alpha must be finite.');
    }
    if (scale > 0 && alpha > 0) copies.push({ offset, scale, alpha });
  }
  return copies;
}
