import { Color, Vector3 } from 'three';
import { vec3 } from 'three/tsl';
import { Emitter, ColorBySpeed, ScaleByDepth, TransformByNoise, DecalRenderer } from '../build/index.mjs';
import { RotationOverLifetime, RotationBySize, RotationBySpeed, RotationByDepth } from '../build/index.mjs';
import { MeshBasicMaterial } from 'three';
import type {
  ModuleCondition, ModuleGPUCondition, ModuleUpdate, ModuleGPUUpdate,
} from '../build/index.mjs';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type CPUConditionArguments = Expect<Equal<Parameters<ModuleCondition>, Parameters<ModuleUpdate>>>;
export type GPUConditionArguments = Expect<Equal<Parameters<ModuleGPUCondition>, Parameters<ModuleGPUUpdate>>>;
export type CPUConditionResult = Expect<Equal<ReturnType<ModuleCondition>, boolean>>;

new Emitter({
  initialValues: {
    color: () => new Set(['red', 0xff0000, new Color('blue')]),
    scale: () => [1, new Vector3(2, 3, 4)],
    scalarVelocity: 2,
    scalarAcceleration: vec3(1),
    position: new Vector3(1, 2, 3),
  },
});
new ColorBySpeed({ color: ['red', () => 0x0000ff] });
new ScaleByDepth({ scale: [1, () => 2], scalarVelocity: 0, scalarAcceleration: 0 });
new TransformByNoise({ strength: 2 });
const decals = new DecalRenderer(new MeshBasicMaterial(), {
  color: () => new Set(['red', 0xffffff, new Color('blue')]),
  size: [1, () => new Vector3(2, 3, 1)],
});
decals.color = '#ff8800';
decals.size = new Vector3(2, 1, 1);
new DecalRenderer(new MeshBasicMaterial(), {
  // @ts-expect-error Directional inputs require explicit vectors.
  direction: 1,
});
new Emitter({ initialValues: {
  // @ts-expect-error Positions require explicit vectors.
  position: 1,
} });
new Emitter({ initialValues: {
  // @ts-expect-error Directional inputs require explicit vectors.
  velocity: 1,
} });

new Emitter({ initialValues: {
  rotation: [0, Math.PI * 2],
  angularVelocity: new Set([-1, 1]),
  angularAcceleration: () => 0.25,
} });
new RotationOverLifetime({ angle: 0.5, angularVelocity: new Set([-2, 2]), angularAcceleration: () => [0, 1] });
new RotationBySize({ angle: [0, 1], angularVelocity: 2, angularAcceleration: () => 0.5 });
new RotationBySpeed({ angle: () => 1, angularVelocity: [0, 2], angularAcceleration: 0 });
new RotationByDepth({ angle: 1, angularVelocity: () => 2, angularAcceleration: [0, 1] });
