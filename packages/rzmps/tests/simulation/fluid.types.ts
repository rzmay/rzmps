import { Color, Vector3 } from 'three';
import { vec3 } from 'three/tsl';
import { AdvectionMethod, FluidBoundsPolicy, FLIPSimulation, GasSimulation, Emitter, ColorBySpeed, ScaleByDepth, TransformByNoise, DecalRenderer } from '../../build/index.mjs';
import { MeshBasicMaterial } from 'three';
import type {
  ModuleCondition, ModuleGPUCondition, ModuleUpdate, ModuleGPUUpdate,
} from '../../build/index.mjs';
import { Module, ParticleSystem } from '../../build/index.mjs';
import type { VolumeFieldProvider, VolumeField } from '../../build/index.mjs';
import { VolumeRenderer, VolumeInterpolation, VolumeDensityMapping, SurfaceRenderer } from '../../build/index.mjs';

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


// A shared membership object can configure both an octree collision backend and fluid collection.
const sharedCollisionOptions: import('../../build/index.mjs').ThreeCollisionBackendOptions = {
  world: new (await import('three')).Scene(),
  staticAfter: 2,
  staticObjectFilter: object => object.name === 'floor',
  dynamicObjectFilter: object => object.name === 'moving wall',
};
new FLIPSimulation({ collisionOptions: sharedCollisionOptions });
new GasSimulation({ collisionOptions: sharedCollisionOptions });


new SurfaceRenderer({ particleRadius: 1.55, influenceRadius: 2.2, anisotropy: 0.35,
  fieldSmoothing: 0.2, velocityDetailRange: [0.5, 3],
  materialCompositeGPU: (_source, dest, context) => ({
    roughness: context.surfaceSpeed?.mul(0.1) ?? dest.roughness,
    color: context.surfaceVorticity?.abs() ?? dest.color,
  }),
  materialComposite: (_source, dest, context) => ({
    roughness: context.surfaceSpeed ? `clamp(${context.surfaceSpeed}, 0.0, 1.0)` : dest.roughness,
  }),
});

const { buildSurfaceNets, buildMarchingCubes, SurfaceExtraction } = await import('../../build/index.mjs');
const customExtractor: import('../../build/index.mjs').SurfaceExtractor = context => buildMarchingCubes(context);
new SurfaceRenderer({ extraction: customExtractor });
new SurfaceRenderer({ extraction: buildSurfaceNets });
new SurfaceRenderer({ extraction: SurfaceExtraction.MarchingCubes });
new SurfaceRenderer({ extraction: 'SurfaceNets' });
new SurfaceRenderer({
  // @ts-expect-error Unsupported extraction names are rejected.
  extraction: 'Unknown',
});

const liquidMaterial = new SurfaceRenderer.LiquidMaterial({
  transmission: 0.8,
  flow: { gradient: ['#246b95', '#f5fbff'], roughness: t => 0.02 + 0.7 * t,
    normalStrength: [0.03, 0.2], vorticityRange: [0.5, 8] },
});
liquidMaterial.setFlow({ distortion: [0, 0.7] });
new SurfaceRenderer({ material: liquidMaterial });

new VolumeRenderer({ samplesPerVoxel: 2, jitterStrength: 1, jitterSeed: 17, anisotropy: 0.6, shadowQuality: 2 });
