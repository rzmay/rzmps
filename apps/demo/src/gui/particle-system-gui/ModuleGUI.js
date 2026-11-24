import * as THREE from 'three';
import { GUIEditorBase } from './GUIEditorBase';
import { LOD_GUI_KEYS } from './constants';
import {
  GasModule, FluidSimulation, FluidBoundsPolicy, PressureSolver, SurfaceAttachment,
  AdvectionMethod, GeometryUpdatePolicy, TransformByNoise, TransformMode,
} from '@rzmps/rzmps';

export class ModuleGUI extends GUIEditorBase {
  buildModulesFolder(root, system = this.system) {
    const section = root.addFolder(`Modules (${system.modules.length})`);
    section.domElement.classList.add('psgui-section', 'psgui-modules');
    section.open();
    system.modules.forEach((module, index) => {
      const folder = section.addFolder(`${index + 1}. ${module.constructor.name}`);
      folder.open();
      this.buildModule(folder, module, system);
    });
    const names = Object.keys(this.moduleFactories);
    const state = { type: names[0] };
    section.add(state, 'type', names).name('Module Type');
    const actions = {
      add: () => {
        system.addModule(this.moduleFactories[state.type]());
        this.rebuild();
        this.emitCode();
      },
    };
    section.add(actions, 'add').name('+ Add Module');
  }

  buildModule(folder, module, system = this.system) {
    const gpuStatus = {
      get compatible() {
        return module.supportsGPU ? 'GPU compatible' : 'CPU only';
      },
    };
    folder.add(gpuStatus, 'compatible').name('GPU').disable().listen();
    this.addTags(folder, module);

    const candidate = module;
    if (candidate instanceof GasModule) {
      folder.add(candidate, 'enabled').name('Enabled').onChange(() => this.emitCode());
    } else if (candidate instanceof SurfaceAttachment) {
      for (const key of ['offset', 'adhesion', 'tangentialDrag', 'inheritSurfaceVelocity',
        'detachDistance', 'killOnDetach']) this.addValue(folder, candidate, key, this.prettyName(key));
    } else if (candidate instanceof FluidSimulation) {
      const tuning = [
        'pressureIterations',
        'pressureMinIterations',
        'pressureMaxIterations',
        'pressureTolerance',
        'pressureWarmStart',
        'adaptiveTimestep',
        'cfl',
        'maxFluidSubsteps',
        'externalForce',
        'maxVelocity',
        'automaticPadding',
        'showGridHelper',
        'picRatio',
        'collisionIterations',
        'particleSeparation',
        'particleSpacing',
        'densityDissipation',
        'temperatureDissipation',
        'colorDissipation',
        'velocityDissipation',
        'densityCutoff',
        'buoyancy',
        'weight',
        'sourceStrength',
        'maxActiveBricks',
        'velocitySourceStrength',
        'supportForceFields',
        'supportSpatialEffects',
        'sourceTemperature',
        'temperatureOverLifetime',
        'scalarDiffusion',
        'vorticityStrength',
        'turbulenceNoiseStrength',
        'turbulenceNoiseFrequency',
        'turbulenceNoiseSpeed',
        'turbulenceNoiseOctaves',
        'temperatureRange',
        'densityRange',
        ...['turbulenceNoiseStrength', 'vorticityStrength', 'densityDissipation', 'temperatureDissipation',
          'velocityDissipation', 'colorDissipation', 'turbulenceNoiseFrequency']
          .flatMap(name => [`${name}ByTemperature`, `${name}ByDensity`]),
      ];
      for (const key of tuning) {
        if (key in candidate) this.addValue(folder, candidate, key, this.prettyName(key));
      }

      // FLIP stores this flag under a runtime name; present its constructor API name.
      if ('advectParticlesEnabled' in candidate) {
        const settings = { advectParticles: candidate.advectParticlesEnabled };
        folder.add(settings, 'advectParticles').name('Advect Particles').onChange(value => {
          candidate.advectParticlesEnabled = value;
          this.emitCode();
        });
      }

      if (candidate.collisionOptions) {
        const collision = folder.addFolder('Collision Options');
        const settings = { surfaceThickness: 0, bakedFieldResolution: 16, staticAfter: 2,
          updatePolicy: GeometryUpdatePolicy.Auto, ...candidate.collisionOptions };
        collision.onChange(() => { candidate.collisionOptions = { ...settings }; });
        collision.add(settings, 'updatePolicy', Object.values(GeometryUpdatePolicy)).name('Update Policy');
        for (const key of ['surfaceThickness', 'bakedFieldResolution', 'staticAfter']) {
          this.addValue(collision, settings, key, this.prettyName(key));
        }
      }
      folder
        .add(candidate, 'boundsPolicy', Object.values(FluidBoundsPolicy))
        .name('Bounds Policy')
        .onChange(() => this.emitCode());
      if ('pressureSolver' in candidate) {
        folder.add(candidate, 'pressureSolver', Object.values(PressureSolver)).name('Pressure Solver')
          .onChange(() => this.emitCode());
        const multigrid = folder.addFolder('Multigrid');
        for (const [key, value] of [['preSmoothing', 2], ['postSmoothing', 4], ['bottomIterations', 12]]) {
          const state = { [key]: candidate.multigrid?.[key] ?? value };
          multigrid.add(state, key, key === 'bottomIterations' ? 1 : 0, 64, 1)
            .name(this.prettyName(key)).onChange(value => {
              candidate.multigrid ??= {};
              candidate.multigrid[key] = value;
              this.emitCode();
            });
        }
      }
    } else if (candidate instanceof TransformByNoise) {
      folder.add(candidate, 'transformMode', Object.values(TransformMode)).name('Transform Mode')
        .onChange(() => { candidate.needsUpdate = true; this.emitCode(); });
      this.addObject(folder, candidate.options,
        new Set(['transformMode', 'tags', 'useOctree', 'useSpatialGrid', ...LOD_GUI_KEYS]));
    } else if (candidate.options && typeof candidate.options === 'object') {
      this.addObject(folder, candidate.options, new Set(['tags', 'useOctree', 'useSpatialGrid', ...LOD_GUI_KEYS]));
    } else {
      const hidden = new Set([
        'modify',
        'executionContext',
        'gpuExecutionContext',
        'benchmarks',
        'evaluateDynamicGPU',
        'modifyGPU',
        'condition',
        'conditionGPU',
        'gpuParameters',
        'noiseGenerator',
        'dependents',
        'priority',
        'backend',
        'useOctree',
        'octreeOptions',
        'octreeAggregator',
        'useSpatialGrid',
        'spatialGridOptions',
        'advectionMethod',
        'boundsPolicy',
        'capOrigin',
        'boundsReconcileKey',
        'advectionAttributes',
        'pressureProjection',
        'velocityAdvected',
        'densityAdvected',
        'colorAdvected',
        'spatialGrid',
        'spatialEffects',
        'collectedSpatialEffects',
        'explicitSpatialEffects',
        'spatialEffectFilter',
        'requireSpatialEffects',
        'collisionListeners',
        'collisionHitSamples',
        'collisionPositionSamples',
        'collisionNormalSamples',
        'collisionHitAttribute',
        'collisionPositionAttribute',
        'collisionNormalAttribute',
        'explicitForceFields',
        'forceFields',
        'forceFieldFilter',
        'octree',
        'sourceOctree',
        'useOctree',
        'useSpatialGrid',
        'spatialGrid',
        'octreeOptions',
        'spatialGridOptions',
        'particleSystem',
        'explicitAffectors',
        'affectors',
        'affectorFilter',
        'particleAffectors',
        'parsedParticleAffectors',
        'alignment',
        'cohesion',
        'separation',
        'affector',
        'toNode',
        'desiredVelocity',
        'currentDirection',
        'affectorDirection',
        'affectorParticlePosition',
        'particleAffectorDirection',
        'worldQuaternion',
        'inverseWorldQuaternion',
        'particleIndices',
        'particleAffectorInfluences',
        'adjustedAggregate',
        'currentAffectorInfluence',
        'quantizedOctreeBounds',
        'octreeBoundsCenter',
        'octreeBoundsSize',
        'listener',
        'tags',
        ...LOD_GUI_KEYS,
      ]);
      Object.keys(candidate)
        .filter(key => !key.startsWith('_') && !hidden.has(key))
        .forEach(key => this.addValue(folder, candidate, key, this.prettyName(key)));
    }
    if (candidate.useOctree) {
      const quality = folder.addFolder('Octree Options');
      quality.close();
      const settings = {
        maxDepth: candidate.octreeOptions.maxDepth ?? 8,
        particlesPerLeaf: candidate.octreeOptions.particlesPerLeaf ?? 4,
        timeQuality: candidate.octreeOptions.timeQuality ?? 1,
        quantizeBounds: candidate.octreeOptions.quantizeBounds ?? 0,
      };
      ['maxDepth', 'particlesPerLeaf', 'timeQuality', 'quantizeBounds'].forEach(key =>
        quality
          .add(settings, key)
          .name(this.prettyName(key))
          .onChange(value => {
            candidate.octreeOptions[key] = value;
            const octree = candidate.getParticleOctree?.();
            if (octree) octree[key] = value;
            this.emitCode();
          }),
      );
    }
    if (candidate instanceof FluidSimulation && 'advectionMethod' in candidate) {
      folder
        .add(candidate, 'advectionMethod', Object.values(AdvectionMethod))
        .name('Advection Method')
        .onChange(() => this.emitCode());
    }
    if (candidate.useSpatialGrid) {
      const quality = folder.addFolder('Spatial Grid Options');
      quality.close();
      const grid = candidate.spatialGrid;
      const options = candidate.spatialGridOptions ?? {};
      if (!candidate.spatialGridOptions) candidate.spatialGridOptions = options;
      const settings = {
        brickSubdivisions: grid?.brickSubdivisions ?? options.brickSubdivisions ?? 3,
        cellSubdivisions: grid?.cellSubdivisions ?? options.cellSubdivisions ?? 4,
        powerOfTwoBounds: grid?.powerOfTwoBounds ?? options.powerOfTwoBounds ?? true,
        cubicBounds: grid?.cubicBounds ?? options.cubicBounds ?? false,
        centeredAtOrigin: grid?.centeredAtOrigin ?? options.centeredAtOrigin ?? false,
        autoExpand: grid?.autoExpand ?? options.autoExpand ?? true,
        autoShrink: grid?.autoShrink ?? options.autoShrink ?? true,
        shrinkDelay: grid?.shrinkDelay ?? options.shrinkDelay ?? 600,
        expansionHysteresis: grid?.expansionHysteresis ?? options.expansionHysteresis ?? 0.125,
        timeQuality: grid?.timeQuality ?? options.timeQuality ?? 1,
        maxQuerySteps: grid?.maxQuerySteps ?? options.maxQuerySteps ?? 0,
        maxBounds: grid?.maxBounds ?? options.maxBounds ?? Infinity,
        minBounds: grid?.minBounds ?? options.minBounds ?? 0,
        autoVolumeQuality: grid?.autoVolumeQuality ?? options.autoVolumeQuality ?? true,
        volumeQuality: grid?.volumeQuality ?? options.volumeQuality ?? 2,
        minVolumeQuality: grid?.minVolumeQuality ?? options.minVolumeQuality ?? 2,
        maxVolumeQuality: grid?.maxVolumeQuality ?? options.maxVolumeQuality ?? Infinity,
      };
      ['brickSubdivisions', 'cellSubdivisions'].forEach(key =>
        quality
          .add(settings, key, 0, 8, 1)
          .name(this.prettyName(key))
          .onChange(value => {
            candidate.setSpatialGridOptions({ [key]: value });
            this.emitCode();
          }),
      );
      [
        'powerOfTwoBounds',
        'cubicBounds',
        'centeredAtOrigin',
        'autoExpand',
        'autoShrink',
        'shrinkDelay',
        'expansionHysteresis',
        'timeQuality',
        'maxQuerySteps',
        'autoVolumeQuality',
        'volumeQuality',
        'minVolumeQuality',
        'maxVolumeQuality',
      ]
        .filter(key => options.bounds || !['cubicBounds', 'centeredAtOrigin'].includes(key))
        .filter(key => !(candidate instanceof FluidSimulation) || ![
          'powerOfTwoBounds', 'cubicBounds', 'centeredAtOrigin', 'autoExpand',
        ].includes(key))
        .forEach(key =>
          quality
            .add(settings, key)
            .name(this.prettyName(key))
            .onChange(value => {
              candidate.setSpatialGridOptions({ [key]: value });
              this.emitCode();
            }),
        );
      for (const key of ['minBounds', 'maxBounds']) {
        const value = settings[key];
        const vector = typeof value === 'number' ? { x: value, y: value, z: value } : value.clone();
        const limits = quality.addFolder(this.prettyName(key));
        for (const axis of ['x', 'y', 'z']) {
          limits.add(vector, axis).onChange(() => {
            candidate.setSpatialGridOptions({ [key]: new THREE.Vector3(vector.x, vector.y, vector.z) });
            this.emitCode();
          });
        }
      }
    }
    const actions = {
      remove: () => {
        system.removeModule(module);
        this.rebuild();
        this.emitCode();
      },
    };
    folder.add(actions, 'remove').name('Remove Module');
  }

  // -------------------------------------------------------------------------
  // Renderers and materials
  // -------------------------------------------------------------------------
}
