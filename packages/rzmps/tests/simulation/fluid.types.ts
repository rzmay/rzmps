import {
  LightingGrid, GasModule, AdvectionMethod, FluidBoundsPolicy, FLIPSimulation, GasSimulation, DecalRenderer,
} from '../../build/index.mjs';
import { MeshBasicMaterial } from 'three';
import { Module, ParticleSystem } from '../../build/index.mjs';
import type { VolumeFieldProvider, VolumeField } from '../../build/index.mjs';
import { VolumeRenderer, VolumeInterpolation, VolumeDensityMapping, SurfaceRenderer } from '../../build/index.mjs';

new VolumeRenderer({ interpolation: VolumeInterpolation.Cubic, densityMapping: 'Curve', densityCurve: t => t * t });
new VolumeRenderer({ softParticleDistance: 0.5 });
new VolumeRenderer({ softParticles: false, softParticleDistance: 0.5 });
new VolumeRenderer({ interpolation: 'Nearest', densityMapping: VolumeDensityMapping.Linear,
  minDensity: 0, maxDensity: 2, densityGain: 2, stepSizeMultiplier: 0.5 });
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

new VolumeRenderer({ color: '#ffffff', minDensity: 0.2, maxDensity: 0.8,
  downsample: 2, dynamicResolution: false, colorByDensity: ['blue', 'red'] });
new VolumeRenderer({
  // @ts-expect-error Density already determines opacity; use the density remapping controls.
  opacityByDensity: [0, 1],
});

new GasSimulation({ temperatureRange: [0, 4], densityRange: [0, 8],
  turbulenceNoiseStrengthByTemperature: [0.5, 2], turbulenceNoiseStrengthByDensity: t => 0.5 + t,
  vorticityStrengthByTemperature: [0.5, 1.5], vorticityStrengthByDensity: [1, 2],
  densityDissipationByTemperature: [0.25, 3], densityDissipationByDensity: [1, 1],
  temperatureDissipationByTemperature: [0.5, 1.5], temperatureDissipationByDensity: [1, 1],
  velocityDissipationByTemperature: [1.2, 0.5], velocityDissipationByDensity: [1, 1],
  colorDissipationByTemperature: [0.5, 2], colorDissipationByDensity: [1, 1],
  turbulenceNoiseFrequencyByTemperature: [0.6, 1.8], turbulenceNoiseFrequencyByDensity: [1, 2] });
new GasSimulation({
  // @ts-expect-error State-dependent solver settings are intentionally unsupported.
  pressureIterationsByTemperature: [8, 32],
});

new VolumeRenderer({ densityNoiseStrengthByTemperature: [0.25, 1.5],
  densityNoiseContrastByTemperature: [0.5, 1.25], densityNoiseFrequencyByTemperature: [1.25, 1] });

new GasSimulation({ spatialGridOptions: { maxBounds: 16 } });
new FLIPSimulation({ spatialGridOptions: { maxBounds: 8 }, boundsPolicy: 'Contain' });
// @ts-expect-error The grid owns the cap; fluid modules do not accept a top-level maxBounds.
new GasSimulation({ maxBounds: 16 });

// Pressure solver values follow the existing string-enum convention.
import { PressureSolver, type MultigridOptions } from '../../build/index.mjs';
const multigridOptions: MultigridOptions = { preSmoothing: 2, postSmoothing: 4, bottomIterations: 12 };
new GasSimulation({ pressureSolver: PressureSolver.Auto, multigrid: multigridOptions });
new GasSimulation({ pressureSolver: 'Multigrid', pressureIterations: 16, pressureTolerance: 0.1 });
new GasSimulation({ multigrid: { preSmoothing: 1 } });
new GasSimulation({ multigrid: {
  // @ts-expect-error Hierarchy depth is internal, not a pressure tuning option.
  levels: 4,
} });
new GasSimulation({
  // @ts-expect-error Solver names are restricted to enum keys/values.
  pressureSolver: 'Jacobi',
});

new GasModule({
  modifyGPU(cell, context) {
    cell.velocity.addAssign(cell.color.mul(context.deltaTime));
    context.turbulenceNoiseStrength.mulAssign(cell.temperature);
    context.densityDissipation.mulAssign(cell.density);
  },
  modifyRenderGPU(cell, context) {
    context.densityNoiseContrast.mulAssign(cell.density);
    context.emission.addAssign(cell.color.mul(cell.temperature));
    // @ts-expect-error Renderer callbacks cannot access persistent solver coefficients.
    context.buoyancy.mulAssign(2);
  },
});

const lightingGrid = new LightingGrid({ levels: 3, directions: [6, 12, 24], cellSize: 0.5 });
new VolumeRenderer({ lightingGridOptions: { levels: 3, directions: [6, 12, 24], cellSize: 0.5 } });
new VolumeRenderer({
  // @ts-expect-error The renderer accepts configuration, not a preconstructed grid.
  lightingGrid,
});
void lightingGrid;
new LightingGrid({ margin: 1, includeSceneLights: false });
new LightingGrid({
  // @ts-expect-error Spatial bounds padding is a scalar or Vector3, not arbitrary text.
  margin: 'large',
});
