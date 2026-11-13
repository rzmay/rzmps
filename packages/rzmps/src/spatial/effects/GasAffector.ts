import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { exp, float, max, mix, pow } from 'three/tsl';
import SpatialEffect, { type SpatialEffectOptions, type SpatialEffectModifier } from './SpatialEffect';
import type { GPUParticleUpdateContext } from '../../simulation/gpu/Particle';
import type { DynamicValue } from '../../values/dynamicValue.types';
import type { ValueByParameter } from '../../values/valueByParameter.types';
import type { ColorInput, Vector3Input } from '../../values/valueInput.types';
import { GPUDynamicParameterStore } from '../../values/evaluateDynamicGPU';
import Priority from '../../enums/Priority';

/** Shader-local specific gas state. Heat and color are premultiplied again by the owning solver. */
export interface GasCellGPU {
  position: Node<'vec3'>;
  density: Node<'float'>;
  temperature: Node<'float'>;
  velocity: Node<'vec3'>;
  color: Node<'vec3'>;
}

/** GPU-only local gas callback. Semantic heat/color writes are transported by the owning solver. */
export type GasModifier = (
  gas: GasCellGPU, deltaTime: Node<'float'>, context: GPUParticleUpdateContext, strength: Node<'float'>,
) => void;

export interface GasAffectorOptions extends Omit<SpatialEffectOptions, 'modifyGPU' | 'automaticFeather'> {
  /** Density added per second; negative values remove density. Null leaves it unchanged. */
  density?: ValueByParameter<number> | null;
  /** Density retention factor per second. One is neutral, zero removes gas. */
  densityMultiplier?: ValueByParameter<number> | null;
  /** Specific temperature added per second; negative values cool the gas. */
  temperature?: ValueByParameter<number> | null;
  /** Acceleration in simulation coordinates, in units per second squared. */
  velocity?: ValueByParameter<Vector3Input> | null;
  /** Velocity damping rate per second. */
  drag?: ValueByParameter<number> | null;
  /** Target specific color, blended using colorRate. */
  color?: ValueByParameter<ColorInput> | null;
  /** Exponential color response per second. Defaults to one. */
  colorRate?: number;
}

/** Local gas-domain modifier; curves use zero at full influence and one at the feather's outer edge. */
export default class GasAffector extends SpatialEffect {
  static Box(
    modify: GasModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): GasAffector;
  /** @hidden Static-side compatibility with SpatialEffect factories; callbacks always receive gas state. */
  static Box(
    modify: SpatialEffectModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): GasAffector;
  static Box(
    options?: Partial<GasAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): GasAffector;
  static Box(
    ...args: ConstructorParameters<typeof THREE.BoxGeometry>
  ): GasAffector;
  static Box(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): GasAffector {
    const { modify, options, geometryArgs } = GasAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.BoxGeometry>
    >(first, second, args);
    return new GasAffector(modify, { ...options, geometry: new THREE.BoxGeometry(...geometryArgs) });
  }

  static Sphere(
    modify: GasModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): GasAffector;
  /** @hidden Static-side compatibility with SpatialEffect factories; callbacks always receive gas state. */
  static Sphere(
    modify: SpatialEffectModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): GasAffector;
  static Sphere(
    options?: Partial<GasAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): GasAffector;
  static Sphere(
    ...args: ConstructorParameters<typeof THREE.SphereGeometry>
  ): GasAffector;
  static Sphere(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): GasAffector {
    const resolved = GasAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.SphereGeometry>
    >(first, second, args);
    return new GasAffector(resolved.modify, {
      ...resolved.options,
      geometry: new THREE.SphereGeometry(...resolved.geometryArgs),
    });
  }

  static Cone(
    modify: GasModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): GasAffector;
  /** @hidden Static-side compatibility with SpatialEffect factories; callbacks always receive gas state. */
  static Cone(
    modify: SpatialEffectModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): GasAffector;
  static Cone(
    options?: Partial<GasAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): GasAffector;
  static Cone(
    ...args: ConstructorParameters<typeof THREE.ConeGeometry>
  ): GasAffector;
  static Cone(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): GasAffector {
    const resolved = GasAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.ConeGeometry>
    >(first, second, args);
    return new GasAffector(resolved.modify, {
      ...resolved.options,
      geometry: new THREE.ConeGeometry(...resolved.geometryArgs),
    });
  }

  static Torus(
    modify: GasModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): GasAffector;
  /** @hidden Static-side compatibility with SpatialEffect factories; callbacks always receive gas state. */
  static Torus(
    modify: SpatialEffectModifier | null,
    options: Partial<GasAffectorOptions> | null,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): GasAffector;
  static Torus(
    options?: Partial<GasAffectorOptions>,
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): GasAffector;
  static Torus(
    ...args: ConstructorParameters<typeof THREE.TorusGeometry>
  ): GasAffector;
  static Torus(
    first?: unknown,
    second?: unknown,
    ...args: unknown[]
  ): GasAffector {
    const resolved = GasAffector.resolveFactoryArgs<
      ConstructorParameters<typeof THREE.TorusGeometry>
    >(first, second, args);
    return new GasAffector(resolved.modify, {
      ...resolved.options,
      geometry: new THREE.TorusGeometry(...resolved.geometryArgs),
    });
  }

  private static resolveFactoryArgs<T extends unknown[]>(
    first: unknown,
    second: unknown,
    rest: unknown[],
  ): { modify: GasModifier | null; options: Partial<GasAffectorOptions>; geometryArgs: T } {
    if (typeof first === 'function' || first === null) {
      return {
        modify: typeof first === 'function' ? first as GasModifier : null,
        options: (second && typeof second === 'object' && !Array.isArray(second)
          ? second as Partial<GasAffectorOptions>
          : {}) ?? {},
        geometryArgs: rest as T,
      };
    }

    return {
      modify: null,
      options: first && typeof first === 'object' && !Array.isArray(first)
        ? first as Partial<GasAffectorOptions>
        : {},
      geometryArgs: (
        first && typeof first === 'object' && !Array.isArray(first)
          ? (second === undefined ? rest : [second, ...rest])
          : [first, second, ...rest].filter((value) => value !== undefined)
      ) as T,
    };
  }

  readonly evaluateDynamicGPU = new GPUDynamicParameterStore();
  density?: GasAffectorOptions['density'];
  densityMultiplier?: GasAffectorOptions['densityMultiplier'];
  temperature?: GasAffectorOptions['temperature'];
  velocity?: GasAffectorOptions['velocity'];
  drag?: GasAffectorOptions['drag'];
  color?: GasAffectorOptions['color'];
  colorRate: number;

  readonly modifyGasGPU: GasModifier | null;

  constructor(modify: GasModifier | null = null, options: Partial<GasAffectorOptions> = {}) {
    super(null, { ...options, priority: options.priority ?? Priority.Permanent, modifyGPU: () => {} });
    this.modifyGasGPU = modify;
    this.density = options.density;
    this.densityMultiplier = options.densityMultiplier;
    this.temperature = options.temperature;
    this.velocity = options.velocity;
    this.drag = options.drag;
    this.color = options.color;
    this.colorRate = options.colorRate ?? 1;
  }

  override get modifiesParticles(): boolean { return false; }

  /** Apply to a local gas state. The caller supplies inherited inclusion/condition/feather strength. */
  applyGasGPU(cell: GasCellGPU, deltaTime: Node<'float'>, context: GPUParticleUpdateContext,
    strength: Node<'float'>): void {
    // Convenience rates compose with the unrestricted local-state callback.
    const parameter = float(1).sub(strength);
    const step = deltaTime.mul(strength);
    const number = (name: 'density' | 'densityMultiplier' | 'temperature' | 'drag', fallback = 0) =>
      this.evaluateDynamicGPU.parameterNumber(name, () => constantCurve(this[name]), parameter, fallback);

    if (this.density != null) cell.density.addAssign(number('density').mul(step));
    if (this.densityMultiplier != null) {
      cell.density.mulAssign(pow(max(number('densityMultiplier', 1), 0), step));
    }
    cell.density.assign(max(cell.density, 0));
    if (this.temperature != null) {
      cell.temperature.assign(max(cell.temperature.add(number('temperature').mul(step)), 0));
    }
    if (this.velocity != null) cell.velocity.addAssign(this.evaluateDynamicGPU.parameterVector(
      'velocity', () => constantCurve(this.velocity), parameter, new THREE.Vector3(),
    ).mul(step));
    if (this.drag != null) cell.velocity.mulAssign(exp(max(number('drag'), 0).mul(step).negate()));
    if (this.color != null) cell.color.assign(mix(cell.color, this.evaluateDynamicGPU.parameterColor(
      'color', () => constantCurve(this.color), parameter, new THREE.Color('white'),
    ), float(1).sub(exp(step.mul(-Math.max(0, this.colorRate))))));
    this.modifyGasGPU?.(cell, deltaTime, context, strength);
    cell.density.assign(max(cell.density, 0));
    cell.temperature.assign(max(cell.temperature, 0));
  }
}

// A literal is a local constant, not a ramp from zero. Arrays/functions retain the normal curve API.
function constantCurve<T>(value: ValueByParameter<T> | null | undefined): DynamicValue<T> | undefined {
  if (value == null) return undefined;
  return typeof value === 'function' || Array.isArray(value) ? value : [value, value];
}
