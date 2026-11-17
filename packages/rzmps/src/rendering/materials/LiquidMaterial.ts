import type { ColorRepresentation } from 'three';
import { Color, MeshPhysicalMaterial, type MeshPhysicalMaterialParameters } from 'three';
import { float, mix, mx_fractal_noise_float, positionLocal, positionView, smoothstep, time, vec3 } from 'three/tsl';
import stretchAlongVelocity from '../shaders/stretchAlongVelocity';
import type { ValueByParameter } from '../../values/valueByParameter.types';

import { evaluateByParameterColorGPU, evaluateByParameterNumberGPU } from '../../values/evaluateByParameterGPU.utils';
import type { MaterialCompositeGPUCallback } from '../compositing/composite.utils';

/** Appearance curves evaluated from combined normalized speed and curl, in the range zero to one. */
export interface LiquidFlowOptions {
  /** Calm-to-active color gradient. Multiplies particle color, blending toward the gradient in active water. */
  gradient: ValueByParameter<ColorRepresentation>;
  /** Physical surface roughness; defaults to 0.5. */
  roughness: ValueByParameter<number>;
  /** Bounded noise-gradient amplitude; defaults to 1. */
  normalStrength: ValueByParameter<number>;
  /** Spatial noise frequency in simulation units; defaults to 1. */
  noiseFrequency: ValueByParameter<number>;
  /** Stretch along flow, clamped below one; defaults to 1. */
  distortion: ValueByParameter<number>;
  /** Noise advection multiplier; defaults to 1. */
  advection: ValueByParameter<number>;
  /** Speeds spanning calm to active water. Defaults to [0, 1]. */
  velocityRange: [number, number];
  /** Curl magnitudes spanning calm to active water. Defaults to [0, 1]. */
  vorticityRange: [number, number];
}

export interface LiquidMaterialOptions extends MeshPhysicalMaterialParameters {
  /** Flow appearance curves. Numbers follow ValueByParameter scaling; use [n, n] for a constant. */
  flow?: Partial<LiquidFlowOptions>;
}

/** Physical water material with flow-driven color, roughness and procedural normal detail on SurfaceRenderer. */
export default class LiquidMaterial extends MeshPhysicalMaterial {
  private flowOptions!: LiquidFlowOptions;
  private surfaceComposite!: MaterialCompositeGPUCallback;

  constructor(options: LiquidMaterialOptions = {}) {
    const { flow, ...physical } = options;
    super({
      color: 'white',
      roughness: 0.035,
      metalness: 0,
      transmission: 0.9,
      thickness: 0.3,
      ior: 1.333,
      attenuationColor: new Color('#b7e4ee'),
      attenuationDistance: 3,
      ...physical,
    });
    this.setFlow({
      gradient: ['#b8e6f3', '#f5fbff'],
      roughness: 0.5,
      normalStrength: 1,
      noiseFrequency: 1,
      distortion: 1,
      advection: 1,
      velocityRange: [0, 1],
      vorticityRange: [0, 1],
      ...flow,
    });
  }

  /** Current settings. Use setFlow to replace curves and rebuild the material graph on its next update. */
  get flow(): Readonly<LiquidFlowOptions> {
    return this.flowOptions;
  }

  /** SurfaceRenderer composes this with the same reconstructed attributes available to user materials. */
  get compositeGPU(): MaterialCompositeGPUCallback {
    return this.surfaceComposite;
  }

  /** Update flow controls without replacing the material or rebuilding the surface geometry. */
  setFlow(options: Partial<LiquidFlowOptions>): this {
    const flow = { ...this.flowOptions, ...options };
    for (const range of [flow.velocityRange, flow.vorticityRange]) {
      if (!range || !range.every(Number.isFinite) || range[1] <= range[0]) {
        throw new RangeError('Liquid material activity ranges must be finite and increasing.');
      }
    }
    this.flowOptions = flow;
    // New callback identity invalidates only the material composition, never reconstruction buffers.
    this.surfaceComposite = (source, dest, context) => {
      const velocity = context.surfaceVelocity ?? vec3(0);
      const speed = context.surfaceSpeed ?? float(0);
      const curl = context.surfaceVorticityMagnitude ?? float(0);
      const moving = smoothstep(...flow.velocityRange, speed);
      const rotating = smoothstep(...flow.vorticityRange, curl);
      const activity = float(1).sub(float(1).sub(moving).mul(float(1).sub(rotating)));
      const numeric = (value: ValueByParameter<number>) => evaluateByParameterNumberGPU(value, activity);
      const tint = evaluateByParameterColorGPU(flow.gradient, activity);
      const point = stretchAlongVelocity(positionLocal, velocity, numeric(flow.distortion), speed)
        .mul(numeric(flow.noiseFrequency).max(0));

      // Blend bounded advection phases so restarting a phase does not jump the visible pattern.
      const phase = time.mul(0.2).fract();
      const secondPhase = phase.add(0.5).fract();
      const advection = velocity.mul(numeric(flow.advection));
      const a = mx_fractal_noise_float(point.sub(advection.mul(phase)), 2, 2, 0.5);
      const b = mx_fractal_noise_float(point.sub(advection.mul(secondPhase)), 2, 2, 0.5);
      const height = mix(b, a, smoothstep(0, 1, float(1).sub(phase.mul(2).sub(1).abs())));

      // Perturb the implicit geometric normal with a bounded view-space noise gradient.
      const normal = context.geometricNormal;
      const dx = positionView.dFdx(),
        dy = positionView.dFdy();
      const tangent = dy.cross(normal),
        bitangent = normal.cross(dx);
      const determinant = dx.dot(tangent);
      const gradient = tangent
        .mul(height.dFdx())
        .add(bitangent.mul(height.dFdy()))
        .mul(determinant.sign())
        .div(determinant.abs().max(1e-6));
      const detail = gradient.div(gradient.length().max(1)).mul(numeric(flow.normalStrength).max(0));

      return {
        color: mix(dest.color.mul(tint), tint, activity.mul(0.65)),
        opacity: source.opacity,
        roughness: numeric(flow.roughness).clamp(0, 1),
        normal: normal.sub(detail).normalize(),
      };
    };
    this.needsUpdate = true;
    return this;
  }

  override copy(source: this): this {
    super.copy(source);
    // Preserve functions/nodes, but isolate mutable color/range endpoints in the renderer-owned clone.
    const clone = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(clone) : value instanceof Color ? value.clone() : value;
    this.setFlow(Object.fromEntries(Object.entries(source.flow).map(([key, value]) => [key, clone(value)])));
    return this;
  }
}
