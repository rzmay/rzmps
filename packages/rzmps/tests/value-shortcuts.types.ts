import { Color, Vector3 } from 'three';
import { vec3 } from 'three/tsl';
import { AdvectionMethod, FluidBoundsPolicy, FLIPSimulation, GasSimulation, Emitter, ColorBySpeed, ScaleByDepth, TransformByNoise, DecalRenderer } from '../build/index.mjs';
import { MeshBasicMaterial } from 'three';
import type {
  ModuleCondition, ModuleGPUCondition, ModuleUpdate, ModuleGPUUpdate,
} from '../build/index.mjs';
import { Module, ParticleSystem } from '../build/index.mjs';
import type { VolumeFieldProvider, VolumeField } from '../build/index.mjs';
import { VolumeRenderer, VolumeInterpolation, VolumeDensityMapping } from '../build/index.mjs';

new VolumeRenderer({ interpolation: VolumeInterpolation.Cubic, densityMapping: 'Curve', densityCurve: t => t * t });
new VolumeRenderer({ interpolation: 'Nearest', densityMapping: VolumeDensityMapping.Linear,
  densityRange: [0, 2], densityGain: 2, stepSizeMultiplier: 0.5 });
new VolumeRenderer({
  // @ts-expect-error Unsupported reconstruction filter.
  interpolation: 'Gaussian',
});

const lookupSystem = new ParticleSystem({ modules: [], emitters: [], renderers: [] });
const gasModules: GasSimulation[] = lookupSystem.getModules(GasSimulation);
lookupSystem.getModules(GasSimulation, ['smoke']);
lookupSystem.getModules<VolumeFieldProvider>(['getVolumeField'], null);
new DecalRenderer(new MeshBasicMaterial(), { generateChildren: false });
const baseModules: Module[] = lookupSystem.getModules(Module);
const volumeModules = lookupSystem.getModules<VolumeFieldProvider>(['getVolumeField']);
interface CustomCapability { sample(): number }
const sample: number | undefined = lookupSystem.getModules<CustomCapability>(['sample'])[0]?.sample();
abstract class Capability { abstract sample(): number }
const constructed: number | undefined = lookupSystem.getModules(Capability)[0]?.sample();
const members = ['sample'] as const;
lookupSystem.getModules<CustomCapability>(members, ['smoke']);
// @ts-expect-error Member names must belong to the requested interface.
lookupSystem.getModules<CustomCapability>(['missing']);
const volume: VolumeField | undefined = volumeModules[0]?.getVolumeField();
void gasModules;
void baseModules;
void sample;
void constructed;
void volume;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
export type CPUConditionArguments = Expect<Equal<Parameters<ModuleCondition>, Parameters<ModuleUpdate>>>;
export type GPUConditionArguments = Expect<Equal<Parameters<ModuleGPUCondition>, Parameters<ModuleGPUUpdate>>>;
export type CPUConditionResult = Expect<Equal<ReturnType<ModuleCondition>, boolean>>;

new GasSimulation({ advectionMethod: AdvectionMethod.MacCormack });
new GasSimulation({ boundsPolicy: FluidBoundsPolicy.Contain });
new FLIPSimulation({ boundsPolicy: 'Kill' });
new FLIPSimulation({
  // @ts-expect-error Unknown cap policies are not supported.
  boundsPolicy: 'Open',
});
new GasSimulation({ advectionMethod: 'SemiLagrangian' });
new GasSimulation({
  // @ts-expect-error Only supported advection enum values and their strings are accepted.
  advectionMethod: 'unsupported',
});

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
