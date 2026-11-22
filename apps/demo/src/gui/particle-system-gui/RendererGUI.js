import * as THREE from 'three';
import {
  AudioRenderer,
  Renderer,
  VolumeRenderer,
  SurfaceRenderer,
  SurfaceExtraction,
  VolumeInterpolation,
  VolumeDensityMapping,
  CompensationMode,

  DecalRenderer,
  SpriteRenderer,
  LightRenderer,
  MeshRenderer,
  TrailRenderer,
  TrailMode,
  TrailTextureMode,
} from '@rzmps/rzmps';
import { GUIEditorBase } from './GUIEditorBase';
import { LOD_GUI_KEYS } from './constants';

export class RendererGUI extends GUIEditorBase {
  buildRenderersFolder(root, system = this.system) {
    const section = root.addFolder(`Renderers (${system.renderers.length})`);
    section.domElement.classList.add('psgui-section', 'psgui-renderers');
    section.open();
    system.renderers.forEach((renderer, index) => {
      const folder = section.addFolder(`${index + 1}. ${renderer.constructor.name}`);
      folder.open();
      this.buildRenderer(folder, renderer, system);
    });
    const names = Object.keys(this.rendererFactories);
    const state = { type: names[0] };
    section.add(state, 'type', names).name('Renderer Type');
    const actions = {
      add: () => {
        const renderer = this.rendererFactories[state.type]();
        system.addRenderer(renderer);
        this.rebuild();
        this.emitCode();
      },
    };
    section.add(actions, 'add').name('+ Add Renderer');
  }

  buildRenderer(folder, renderer, system = this.system) {
    this.addTags(folder, renderer);

    // DecalRenderer.count reports live decals; its constructor count still controls source grouping.
    const countAccess = Object.getOwnPropertyDescriptor(Renderer.prototype, 'count');
    const grouping = renderer instanceof DecalRenderer ? {
      get count() { return countAccess.get.call(renderer); },
      set count(value) { countAccess.set.call(renderer, value); },
    } : renderer;
    folder.add(grouping, 'count', -1).step(1).name('Count');
    folder.add(renderer, 'ratio', 0, 1).name('Ratio');
    folder.add(renderer, 'groupingRadius', -1).name('Grouping Radius');
    folder.add(renderer, 'compensation', CompensationMode).name('Compensation');
    folder.add(renderer, 'generateChildren').name('Generate Children');
    const children = folder.addFolder('Children');
    const defaults = {
      count: 0,
      radius: 0,
      rotation: new THREE.Vector3(),
      scale: 1,
      alpha: 1,
      randomizeRotation: 0,
      randomizeScale: 0,
      randomizeAlpha: 0,
    };
    // Display defaults without changing the renderer merely by opening its editor.
    const childOptions = { ...defaults, ...renderer.children };
    children.onChange(() => { renderer.children = { ...childOptions }; });
    this.addObject(children, childOptions);

    if (renderer instanceof VolumeRenderer) {
      this.buildVolumeRenderer(folder, renderer);
    } else if (renderer instanceof SurfaceRenderer) {
      this.buildSurfaceRenderer(folder, renderer);
    } else if (renderer instanceof SpriteRenderer) {
      this.buildSpriteRenderer(folder, renderer);
    } else if (renderer instanceof LightRenderer) {
      this.buildLightRenderer(folder, renderer);
    } else if (renderer instanceof MeshRenderer) {
      this.buildMeshRenderer(folder, renderer);
    } else if (renderer instanceof TrailRenderer) {
      this.buildTrailRenderer(folder, renderer);
    } else if (renderer instanceof DecalRenderer) {
      // Only edit configuration. Renderer internals include the owning system/scene.
      for (const key of [
        'materialIndex',
        'warp',
        'inheritMaterial',
        'unionCoverage',
        'duplicateDistance',
        'duplicateInterval',
        'direction',
        'hitSelection',
        'maxHits',
        'maxDistance',
        'depth',
        'offset',
        'size',
        'rotation',
        'color',
        'lifetime',
        'opacity',
        'inheritColor',
        'inheritScale',
        'inheritAlpha',
        'distanceAffectsOpacity',
        'distanceAffectsSize',
        'maxDecals',
        'onSpawn',
        'onCollision',
        'impulseThreshold',
        'onDeath',
        'continuousRate',
        'impulseAffectsSize',
        'impulseAffectsOpacity',
        'impulseAffectsLifetime',
      ]) {
        this.addValue(folder, renderer, key, this.prettyName(key));
      }
    } else if (renderer instanceof AudioRenderer) {
      this.buildAudioRenderer(folder, renderer);
    } else {
      this.addObject(
        folder,
        renderer,
        new Set([
          'setup',
          'executionContext',
          'gpuExecutionContext',
          'benchmarks',
          'evaluateDynamicGPU',
          'gpuExecutionContext',
          'update',
          'destroy',
          'mesh',
          'geometry',
          'material',
          'tags',
          ...LOD_GUI_KEYS,
        ]),
      );
    }

    const actions = {
      remove: () => {
        system.removeRenderer(renderer);
        this.rebuild();
        this.emitCode();
      },
    };
    folder.add(actions, 'remove').name('Remove Renderer');
  }

  buildVolumeRenderer(folder, renderer) {
    folder.add(renderer, 'interpolation', Object.values(VolumeInterpolation)).name('Interpolation');
    folder.add(renderer, 'densityMapping', Object.values(VolumeDensityMapping)).name('Density Mapping');
    folder.add(renderer, 'samplesPerVoxel', 0.25, 8, 0.25).name('Samples Per Voxel');
    folder.add(renderer, 'jitterStrength', 0, 1, 0.01).name('Jitter Strength');
    folder.add(renderer, 'anisotropy', -0.9, 0.9, 0.01).name('Anisotropy');
    folder.add(renderer, 'shadowQuality', 0, 8, 0.25).name('Shadow Quality');
    if (renderer.lightingGridOptions) {
      const lighting = folder.addFolder('Lighting Grid Options');
      const grid = {
        levels: 2, directions: 4, samplesPerInterval: 4, scatteringIterations: 1,
        environmentIntensity: 1, includeSceneLights: true, levelScale: 2,
        ...renderer.lightingGridOptions,
      };
      lighting.onChange(() => { renderer.lightingGridOptions = { ...grid }; });
      lighting.add(grid, 'levelScale', 1, 4, 0.1).name('Level Scale');
      lighting.add(grid, 'levels', 1, 6, 1).name('Levels');
      if (typeof grid.directions === 'number') lighting.add(grid, 'directions', 2, 16, 1).name('Directions');
      lighting.add(grid, 'samplesPerInterval', 1, 16, 1).name('Samples Per Interval');
      lighting.add(grid, 'scatteringIterations', 0, 4, 1).name('Scattering Iterations');
      lighting.add(grid, 'environmentIntensity', 0, 4, 0.05).name('Environment Intensity');
      lighting.add(grid, 'includeSceneLights').name('Include Scene Lights');
      for (const key of ['maxDistance', 'margin', 'ambient']) {
        if (grid[key] !== undefined) this.addValue(lighting, grid, key, this.prettyName(key));
      }
      if (grid.cellSize !== undefined) lighting.add(grid, 'cellSize', 0.01, 4, 0.01).name('Cell Size');
    }

    folder.add(renderer, 'steps', 1, 512, 1).name('Steps');

    // These controls are root VolumeRenderer options, not a nested marching object.
    this.addValue(folder, renderer, 'dynamicResolution', 'Dynamic Resolution');
    folder.add(renderer, 'downsample', 1, 8, 1).name('Downsample');
    folder.add(renderer, 'emptySpaceSkipping').name('Empty Space Skipping');
    folder.add(renderer, 'adaptiveStepping').name('Adaptive Stepping');
    folder.add(renderer, 'adaptiveStepThreshold', 0, 0.99, 0.01).name('Adaptive Step Threshold');
    folder.add(renderer, 'adaptiveStepFactor', 1, 16, 0.25).name('Adaptive Step Factor');
    folder.add(renderer, 'transmittanceThreshold', 0, 0.1, 0.001).name('Transmittance Threshold');
    folder.add(renderer, 'sceneDepthClipping').name('Scene Depth Clipping');
    folder.add(renderer, 'sceneDepthBias', 0, 0.1, 0.001).name('Scene Depth Bias');
    folder.add(renderer, 'softParticles').name('Soft Particles');
    folder.add(renderer, 'softParticleDistance', 0).name('Soft Particle Distance');
    folder.add(renderer, 'densityGain', 0, 10, 0.05).name('Density Gain');
    folder.add(renderer, 'emissive', 0, 1, 0.01).name('Emissive');
    for (const parameter of ['Temperature', 'Density', 'Speed', 'Vorticity']) {
      for (const kind of ['color', 'opacity', 'emissive']) {
        if (kind === 'emissive' && parameter === 'Vorticity') continue;
        if (parameter === 'Density' && kind === 'opacity') continue;
        const key = `${kind}By${parameter}`;
        this.addValue(folder, renderer, key, this.prettyName(key));
      }
      if (parameter !== 'Density') {
        const key = `${parameter.toLowerCase()}Range`;
        this.addValue(folder, renderer, key, this.prettyName(key));
      }
    }
    folder.add(renderer, 'densityNoiseStrength', 0, 8, 0.01).name('Density Noise Strength');
    folder.add(renderer, 'densityNoiseContrast', 0, 8, 0.01).name('Density Noise Contrast');
    folder.add(renderer, 'densityNoiseFrequency', 0, 20, 0.1).name('Density Noise Frequency');
    folder.add(renderer, 'densityNoiseSpeed', -2, 2, 0.01).name('Density Noise Speed');
    folder.add(renderer, 'densityNoiseOctaves', 1, 4, 1).name('Density Noise Octaves');
    folder.add(renderer, 'densityNoiseStretch', 0, 0.95, 0.01).name('Density Noise Stretch');
    for (const key of [
      'densityNoiseStrengthByTemperature', 'densityNoiseContrastByTemperature', 'densityNoiseFrequencyByTemperature',
      'densityNoiseStretchByTemperature', 'densityNoiseStretchByDensity', 'densityNoiseStretchBySpeed',
    ]) {
      this.addValue(folder, renderer, key, this.prettyName(key));
    }
    for (const key of [
      'color',
      'opacity',
      'threshold',
      'range',
      'minDensity',
      'maxDensity',
      'densityCurve',
      'depthTest',
      'jitter',
      'jitterSeed',
      'stepSizeMultiplier',
      'renderOrder',
    ]) {
      this.addValue(folder, renderer, key, this.prettyName(key));
    }
  }

  buildSurfaceRenderer(folder, renderer) {
    if (typeof renderer.extraction !== 'function') {
      folder.add(renderer, 'extraction', SurfaceExtraction).name('Extraction');
    }
    folder.add(renderer, 'smoothingIterations', 0, 16, 1).name('Smoothing Iterations');
    folder.add(renderer, 'smoothingStrength', 0, 1, 0.01).name('Smoothing Strength');
    for (const key of [
      'voxelSize',
      'particleRadius',
      'influenceRadius',
      'anisotropy',
      'anisotropyMinNeighbors',
      'anisotropyMaxStretch',
      'anisotropyRadius',
      'dropletSupportMin',
      'dropletSupportMax',
      'fieldSmoothingIterations',
      'fieldSmoothing',
      'fieldClosing',
      'flowSmoothing',
      'deformationDetailRange',
      'velocityDetailRange',
      'vorticityDetailRange',
      'isoLevel',
      'bounds',
      'particleColors',
      'castShadow',
      'receiveShadow',
    ]) {
      this.addValue(folder, renderer, key, this.prettyName(key));
    }
    const grid = folder.addFolder('Spatial Grid Options');
    for (const key of ['brickSubdivisions', 'cellSubdivisions', 'maxQuerySteps']) {
      this.addValue(grid, renderer.spatialGridOptions, key, this.prettyName(key));
    }
    const material = folder.addFolder('Material');
    if (renderer.material instanceof SurfaceRenderer.LiquidMaterial) {
      const flow = material.addFolder('Flow');
      // Rebuild only the material graph when an appearance curve changes.
      const settings = { ...renderer.material.flow };
      flow.onChange(() => renderer.material.setFlow(settings));
      for (const key of Object.keys(settings)) {
        if (key !== 'velocityRange') this.addValue(flow, settings, key, this.prettyName(key));
      }
    }
    for (const key of [
      'color',
      'roughness',
      'metalness',
      'clearcoat',
      'transmission',
      'thickness',
      'ior',
      'attenuationColor',
      'attenuationDistance',
      'opacity',
      'transparent',
      'wireframe',
    ]) {
      if (key === 'roughness' && renderer.material instanceof SurfaceRenderer.LiquidMaterial) continue;
      if (key in renderer.material) this.addValue(material, renderer.material, key, this.prettyName(key));
    }
  }

  buildSpriteRenderer(folder, renderer) {
    this.addDynamicValue(folder, renderer, 'fps', 'FPS');
    folder.add(renderer, 'billboard').name('Billboard');
    folder.add(renderer, 'sizeAttenuation').name('Size Attenuation');
    folder.add(renderer, 'castShadow').name('Cast Shadow');
    folder.add(renderer, 'softParticleDistance', 0).name('Soft Particle Distance');
    folder
      .add(renderer, 'frames')
      .min(1)
      .step(1)
      .name('Frames')
      .onFinishChange(() => this.reloadSpriteMaterial(renderer));
    const materialState = { material: renderer.materialType };
    folder
      .add(materialState, 'material', ['unlit', 'lit'])
      .name('Material')
      .onChange(value => {
        renderer.materialType = value;
        this.reloadSpriteMaterial(renderer);
      });
    const gridSizeFolder = folder.addFolder('Grid Size');
    gridSizeFolder.close();
    this.addVector2(gridSizeFolder, renderer.gridSize, 'Grid', () => this.reloadSpriteMaterial(renderer));

    const tileSizeFolder = folder.addFolder('Tile Size');
    tileSizeFolder.close();
    this.addVector2(tileSizeFolder, renderer.tileSize, 'Tile');

    const tileMarginFolder = folder.addFolder('Tile Margin');
    tileMarginFolder.close();
    this.addVector2(tileMarginFolder, renderer.tileMargin, 'Margin');
    const info = {
      texture: renderer.texture?.name || renderer.texture?.uuid || '(texture)',
      alphaMap: renderer.alphaMap?.name || renderer.alphaMap?.uuid || '(none)',
    };
    folder.add(info, 'texture').name('Texture').disable();
    folder.add(info, 'alphaMap').name('Alpha Map').disable();
    this.addTextureUpload(folder, 'Upload Texture', texture => {
      renderer.texture = texture;
      renderer.materialOptions = { ...renderer.materialOptions };
    });
    this.addTextureUpload(folder, 'Upload Alpha Map', texture => {
      renderer.alphaMap = texture;
      renderer.materialOptions = { ...renderer.materialOptions };
    });

    const materialOptionsFolder = folder.addFolder('Material Options');
    materialOptionsFolder.close();
    this.buildSpriteMaterialOptionsFolder(materialOptionsFolder, renderer);
  }

  buildSpriteMaterialOptionsFolder(folder, renderer) {
    const optionDefinitions = [
      ['opacity', 'Opacity', 0, 1, 0.01],
      ['alphaTest', 'Alpha Test', 0, 1, 0.001],
      ['roughness', 'Roughness', 0, 1, 0.01],
      ['metalness', 'Metalness', 0, 1, 0.01],
      ['normalStrength', 'Normal Strength', 0, 4, 0.01],
      ['normalLighting', 'Normal Lighting', 0, 1, 0.01],
      ['sphericalNormals', 'Spherical Normals', 0, 1, 0.01],
      ['transmission', 'Transmission', 0, 1, 0.01],
      ['distortionStrength', 'Distortion Strength', -0.25, 0.25, 0.001],
      ['envIntensity', 'Env Intensity', 0, 10, 0.01],
    ];

    optionDefinitions.forEach(([key, label, min, max, step]) => {
      const state = {
        [key]: renderer.materialOptions[key] ?? this.defaultSpriteMaterialOption(key),
      };

      folder
        .add(state, key, min, max, step)
        .name(label)
        .onChange(value => {
          renderer.materialOptions = {
            ...renderer.materialOptions,
            [key]: value,
          };
        });
    });

    this.addTextureUpload(folder, 'Upload Normal Map', texture => {
      renderer.materialOptions = {
        ...renderer.materialOptions,
        normalMap: texture,
      };
    });
    this.addTextureUpload(folder, 'Upload Roughness Map', texture => {
      renderer.materialOptions = {
        ...renderer.materialOptions,
        roughnessMap: texture,
      };
    });
    this.addTextureUpload(folder, 'Upload Metalness Map', texture => {
      renderer.materialOptions = {
        ...renderer.materialOptions,
        metalnessMap: texture,
      };
    });
    this.addTextureUpload(folder, 'Upload Transmission Map', texture => {
      renderer.materialOptions = {
        ...renderer.materialOptions,
        transmissionMap: texture,
      };
    });
    this.addTextureUpload(folder, 'Upload Distortion Map', texture => {
      renderer.materialOptions = {
        ...renderer.materialOptions,
        distortionMap: texture,
      };
    });
  }

  defaultSpriteMaterialOption(key) {
    switch (key) {
      case 'opacity':
        return 1;
      case 'roughness':
        return 0.5;
      default:
        return 0;
    }
  }

  buildLightRenderer(folder, renderer) {
    if (renderer.power === undefined) this.addDynamicValue(folder, renderer, 'brightness', 'Brightness');
    this.addDynamicValue(folder, renderer, 'rangeMultiplier', 'Range Multiplier');
    this.addDynamicValue(folder, renderer, 'color', 'Color');
    this.addDynamicValue(folder, renderer, 'distance', 'Distance');
    this.addDynamicValue(folder, renderer, 'decay', 'Decay');
    const allocation = folder.addFolder('Allocation');
    allocation.add(renderer.allocation, 'shrinkThreshold', 0, 1).name('Shrink Threshold');
    allocation.add(renderer.allocation, 'shrinkDelay', 0).name('Shrink Delay');
    folder.add(renderer, 'inheritParticleColor').name('Inherit Particle Color');
    folder.add(renderer, 'sizeAffectsRange').name('Size Affects Range');
    folder.add(renderer, 'alphaAffectsIntensity').name('Alpha Affects Intensity');
    // Power is an alternative unit for emission, not a second brightness multiplier.
    const power = { enabled: renderer.power !== undefined };
    folder.add(power, 'enabled').name('Use Power').onChange(enabled => {
      if (enabled) renderer.power = 4 * Math.PI;
      else renderer.power = undefined;
      this.rebuild();
      this.emitCode();
    });
    if (power.enabled) this.addDynamicValue(folder, renderer, 'power', 'Power');
  }

  buildMeshRenderer(folder, renderer) {
    const info = {
      mesh: renderer.mesh.name || renderer.mesh.uuid,
      geometry: renderer.mesh.geometry.type,
      material: Array.isArray(renderer.mesh.material)
        ? `${renderer.mesh.material.length} materials`
        : renderer.mesh.material.type,
      capacity: renderer.maxParticles,
    };
    folder.add(info, 'mesh').name('Mesh').disable();
    folder.add(info, 'geometry').name('Geometry').disable();
    folder.add(info, 'material').name('Material').disable();
    folder.add(info, 'capacity').name('Capacity').disable();
    folder.add(renderer, 'castShadow').name('Cast Shadow');
    folder.add(renderer, 'receiveShadow').name('Receive Shadow');
    const materialFolder = folder.addFolder('Material');
    materialFolder.close();
    this.buildMaterialFolder(materialFolder, renderer.mesh.material);
  }

  buildTrailRenderer(folder, renderer) {
    const modeState = {
      mode: renderer.mode,
    };

    folder
      .add(modeState, 'mode', {
        Particle: TrailMode.Particle,
        Ribbon: TrailMode.Ribbon,
      })
      .name('Mode')
      .onChange(value => {
        renderer.mode = Number(value);
        this.rebuild();
      });


    this.addDynamicValue(folder, renderer, 'lifetime', 'Lifetime');

    folder.add(renderer, 'minimumVertexDistance', 0).name('Minimum Vertex Distance');

    folder.add(renderer, 'dieWithParticles').name('Die With Particles');

    if (renderer.mode === TrailMode.Ribbon) {
      folder.add(renderer, 'ribbonCount', 1).step(1).name('Ribbon Count');
    }

    const textureState = {
      textureMode: renderer.textureMode,
    };

    folder
      .add(textureState, 'textureMode', {
        Stretch: TrailTextureMode.Stretch,
        Tile: TrailTextureMode.Tile,
        'Repeat Per Segment': TrailTextureMode.RepeatPerSegment,
        'Distribute Per Segment': TrailTextureMode.DistributePerSegment,
      })
      .name('Texture Mode')
      .onChange(value => {
        renderer.textureMode = Number(value);
      });

    this.addDynamicValue(folder, renderer, 'width', 'Width');

    this.addDynamicValue(folder, renderer, 'widthOverTrail', 'Width Over Trail');

    folder.add(renderer, 'sizeAffectsWidth').name('Size Affects Width');

    folder.add(renderer, 'sizeAffectsLifetime').name('Size Affects Lifetime');

    folder.add(renderer, 'castShadow').name('Cast Shadow');
    folder.add(renderer, 'receiveShadow').name('Receive Shadow');

    folder.add(renderer, 'inheritParticleColor').name('Inherit Particle Color');

    this.addDynamicValue(folder, renderer, 'colorOverLifetime', 'Color Over Lifetime');

    this.addDynamicValue(folder, renderer, 'colorOverTrail', 'Color Over Trail');

    const materialFolder = folder.addFolder('Material');
    materialFolder.close();
    this.buildTrailMaterialFolder(materialFolder, renderer);
  }

  buildTrailMaterialFolder(folder, renderer) {
    this.buildMaterialFolder(folder, renderer.material);
  }

  buildAudioRenderer(folder, renderer) {
    // Audio output owns scene nodes and benchmark storage; edit only its public behavior options.
    for (const key of [
      'loop', 'maxClips', 'collisionRatio', 'pitch', 'volume', 'highPass', 'lowPass',
      'onSpawn', 'onCollision', 'onDeath', 'shouldPlay', 'dopplerEffect', 'impulseThreshold',
      'gpuInterpolationRate',
      ...['size', 'alpha', 'speed', 'depth', 'impulse'].flatMap(parameter =>
        ['Pitch', 'Volume', 'HighPass', 'LowPass'].map(property => `${parameter}Affects${property}`)),
    ]) {
      this.addDynamicValue(folder, renderer, key, this.prettyName(key));
    }
    for (const key of ['sound', 'onCollisionSound', 'onSpawnSound', 'onDeathSound']) {
      this.addAudioUpload(folder, renderer, key, this.prettyName(key));
    }
  }

  buildMaterialFolder(folder, materialOrMaterials) {
    const materials = Array.isArray(materialOrMaterials) ? materialOrMaterials : [materialOrMaterials];

    const material = materials[0];

    if (!material) {
      return;
    }

    const info = {
      type: material.type,
    };

    folder.add(info, 'type').name('Type').disable();

    if ('color' in material && material.color instanceof THREE.Color) {
      const state = {
        color: `#${material.color.getHexString()}`,
      };

      folder
        .addColor(state, 'color')
        .name('Color')
        .onChange(value => {
          material.color.set(value);
        });
    }

    const numericControls = [
      ['opacity', 'Opacity', 0, 1, 0.01],
      ['alphaTest', 'Alpha Test', 0, 1, 0.001],
      ['roughness', 'Roughness', 0, 1, 0.01],
      ['metalness', 'Metalness', 0, 1, 0.01],
      ['envMapIntensity', 'Env Map Intensity', 0, 10, 0.01],
      ['emissiveIntensity', 'Emissive Intensity', 0, 10, 0.01],
      ['ior', 'IOR', 1, 2.333, 0.001],
      ['reflectivity', 'Reflectivity', 0, 1, 0.01],
      ['clearcoat', 'Clearcoat', 0, 1, 0.01],
      ['clearcoatRoughness', 'Clearcoat Roughness', 0, 1, 0.01],
      ['transmission', 'Transmission', 0, 1, 0.01],
      ['thickness', 'Thickness', 0, 10, 0.01],
      ['attenuationDistance', 'Attenuation Distance', 0, 100, 0.01],
      ['sheen', 'Sheen', 0, 1, 0.01],
      ['sheenRoughness', 'Sheen Roughness', 0, 1, 0.01],
      ['iridescence', 'Iridescence', 0, 1, 0.01],
      ['iridescenceIOR', 'Iridescence IOR', 1, 2.333, 0.001],
      ['anisotropy', 'Anisotropy', 0, 1, 0.01],
    ];

    numericControls.forEach(([key, label, min, max, step]) => {
      if (!(key in material) || typeof material[key] !== 'number') {
        return;
      }

      folder
        .add(material, key, min, max, step)
        .name(label)
        .onChange(() => {
          material.needsUpdate = true;
        });
    });

    if ('emissive' in material && material.emissive instanceof THREE.Color) {
      const state = {
        emissive: `#${material.emissive.getHexString()}`,
      };

      folder
        .addColor(state, 'emissive')
        .name('Emissive')
        .onChange(value => {
          material.emissive.set(value);
        });
    }

    if ('wireframe' in material) {
      folder.add(material, 'wireframe').name('Wireframe');
    }

    if ('map' in material) {
      this.addTextureUpload(folder, 'Upload Map', texture => {
        material.map = texture;
        material.needsUpdate = true;
      });
    }
  }
  // -------------------------------------------------------------------------
  // File uploads
  // -------------------------------------------------------------------------
  reloadSpriteMaterial(renderer) {
    renderer.loadMaterial?.();
  }
}
