import { Color, Vector3 } from 'three';
import { vec3 } from 'three/tsl';
import { AdvectionMethod, FluidBoundsPolicy, FLIPSimulation, GasSimulation, Emitter, ColorBySpeed, ScaleByDepth, TransformByNoise, DecalRenderer } from '../../build/index.mjs';
import { MeshBasicMaterial } from 'three';
import type {
  ModuleCondition, ModuleGPUCondition, ModuleUpdate, ModuleGPUUpdate,
} from '../../build/index.mjs';
import { Module, ParticleSystem } from '../../build/index.mjs';
import type { VolumeFieldProvider, VolumeField } from '../../build/index.mjs';
import { VolumeRenderer, VolumeInterpolation, VolumeDensityMapping } from '../../build/index.mjs';

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
