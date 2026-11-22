import * as THREE from 'three';
import * as TSL from 'three/tsl';
import * as RZMPS from '@rzmps/rzmps';
import { GUI } from 'lil-gui';
import { ModuleGUI } from '../../../src/gui/particle-system-gui/ModuleGUI.js';
import { RendererGUI } from '../../../src/gui/particle-system-gui/RendererGUI.js';
import { GUIValueEditor } from '../../../src/gui/particle-system-gui/GUIValueEditor.js';
import { ParticleSystemSerializer } from '../../../src/gui/particle-system-gui/ParticleSystemSerializer.js';

// Configuration-only fixture: exercise real controllers and constructors without preparing a GPU simulation.
window.checkGUI = () => {
  const { ParticleSystem, GasSimulation, FLIPSimulation, VolumeRenderer, SurfaceRenderer,
    LightRenderer, DecalRenderer, AudioRenderer } = RZMPS;
  const gas = new GasSimulation({ collisionOptions: {}, spatialGridOptions: { maxBounds: 16 } });
  const flip = new FLIPSimulation({ pressureIterations: 21, pressureTolerance: 0.03,
    pressureWarmStart: false, cfl: 1.25, adaptiveTimestep: false, maxFluidSubsteps: 3 });
  gas.runtimeDataForOtherModules = 42;
  const volume = new VolumeRenderer({ lightingGridOptions: {}, count: 18, ratio: 0.75,
    groupingRadius: 3, densityNoiseStretch: 0.2, emissiveByTemperature: value => value * value });
  const surface = new SurfaceRenderer();
  const light = new LightRenderer({ brightness: [2, 3], power: undefined, count: 5 });
  const audio = new AudioRenderer({ volume: 0.6, shouldPlay: particle => particle.alpha > 0.25 });
  audio.runtimeDataForOtherModules = 42;
  const decal = new DecalRenderer(new THREE.MeshBasicMaterial(), { count: 12,
    warp: DecalRenderer.Warp.Scale(2), inheritMaterial: false, duplicateDistance: 0.2 });
  const system = new ParticleSystem({ substep: false, substepDeltaTime: 0.02, maxCatchup: 0.4,
    cubemapSettings: { fps: 15, resolutionScale: 0.25, intensity: 0.8 },
    modules: [gas, flip], renderers: [volume, surface, light, decal, audio] });
  const gui = new GUI();
  let code, emissions = 0;
  const host = { system, rebuild() {},
    prettyName: key => key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()),
    emitCode() { emissions++; code = serializer.serializeParticleSystem(); },
  };
  host.valueEditor = new GUIValueEditor(host);
  const modules = new ModuleGUI(host), renderers = new RendererGUI(host);
  const serializer = new ParticleSystemSerializer(host);
  gui.onChange(() => host.emitCode());
  const before = serializer.serializeParticleSystem();
  const folders = {};
  for (const [name, value, editor, method] of [
    ['Gas', gas, modules, 'buildModule'], ['FLIP', flip, modules, 'buildModule'],
    ['Volume', volume, renderers, 'buildRenderer'], ['Surface', surface, renderers, 'buildRenderer'],
    ['Audio', audio, renderers, 'buildRenderer'],
    ['Light', light, renderers, 'buildRenderer'], ['Decal', decal, renderers, 'buildRenderer'],
  ]) {
    folders[name] = gui.addFolder(name);
    editor[method](folders[name], value, system);
  }
  const unchanged = before === serializer.serializeParticleSystem();
  const controls = [];
  const visit = (folder, prefix = '') => {
    for (const controller of folder.controllers) {
      controls.push({ path: `${prefix}/${controller._name}`, key: controller.property, controller });
    }
    for (const child of folder.folders) visit(child, `${prefix}/${child._title}`);
  };
  visit(gui);
  const change = (path, value) => {
    const control = controls.find(control => control.path === path);
    if (!control) throw new Error(`Missing ${path}; available: ${controls.map(control => control.path).join(', ')}`);
    control.controller.setValue(value);
  };
  change('/Audio/Volume', 0.4);
  change('/Decal/Count', 8);
  change('/FLIP/Advect Particles', true);
  change('/FLIP/Cfl', 1.5);
  change('/Gas/Collision Options/Baked Field Resolution', 24);
  change('/Gas/Spatial Grid Options/Cell Subdivisions', 3);
  change('/Volume/Lighting Grid Options/Levels', 3);
  change('/Volume/Children/Count', 2);
  change('/Volume/Generate Children', false);
  change('/Volume/Density Noise Stretch', 0.4);
  change('/Light/Allocation/Shrink Delay', 4);
  change('/Surface/Material/Flow/Noise Speed/0', 0.4);

  // Execute the generated module against the same public namespaces, including its import bindings.
  const executable = code.replace(/^import (.+) from '([^']+)';$/gm, (_line, bindings, source) => {
    const names = bindings.startsWith('* as ') ? bindings.slice(5) : bindings;
    return `const ${names} = imports[${JSON.stringify(source)}];`;
  }).replace('export default ', 'return ');
  const copy = new Function('imports', executable)({ three: THREE, 'three/tsl': TSL, '@rzmps/rzmps': RZMPS });
  const copiedGas = copy.modules.find(module => module instanceof GasSimulation);
  const copiedFlip = copy.modules.find(module => module instanceof FLIPSimulation);
  const copiedVolume = copy.renderers.find(renderer => renderer instanceof VolumeRenderer);
  const copiedLight = copy.renderers.find(renderer => renderer instanceof LightRenderer);
  const result = { system: { substep: copy.substep, delta: copy.substepDeltaTime, maxCatchup: copy.maxCatchup,
    fps: copy.liveCubemap.fps, scale: copy.liveCubemap.resolutionScale, intensity: copy.liveCubemap.intensity },
    unchanged, emissions, paths: controls.map(({ path }) => path), code,
    gas: { resolution: copiedGas.collisionOptions.bakedFieldResolution,
      subdivisions: copiedGas.spatialGridOptions.cellSubdivisions },
    flip: { advect: copiedFlip.advectParticlesEnabled, cfl: copiedFlip.cfl,
      iterations: copiedFlip.pressureIterations, tolerance: copiedFlip.pressureTolerance,
      warmStart: copiedFlip.pressureWarmStart, adaptive: copiedFlip.adaptiveTimestep,
      substeps: copiedFlip.maxFluidSubsteps },
    volume: { levels: copiedVolume.lightingGridOptions.levels, count: copiedVolume.count,
      ratio: copiedVolume.ratio, groupingRadius: copiedVolume.groupingRadius,
      children: copiedVolume.children.count, generateChildren: copiedVolume.generateChildren,
      stretch: copiedVolume.densityNoiseStretch, emissive: copiedVolume.emissiveByTemperature(0.5) },
    audio: { volume: copy.renderers.find(renderer => renderer instanceof AudioRenderer).volume,
      accepts: copy.renderers.find(renderer => renderer instanceof AudioRenderer).shouldPlay({ alpha: 0.5 }) },
    decal: { scale: copy.renderers.find(renderer => renderer instanceof DecalRenderer).warp.scale.toArray(),
      inheritMaterial: copy.renderers.find(renderer => renderer instanceof DecalRenderer).inheritMaterial,
      duplicateDistance: copy.renderers.find(renderer => renderer instanceof DecalRenderer).duplicateDistance },
    decalCount: Object.getOwnPropertyDescriptor(RZMPS.Renderer.prototype, 'count').get.call(
      copy.renderers.find(renderer => renderer instanceof DecalRenderer)),
    surfaceNoise: copy.renderers.find(renderer => renderer instanceof SurfaceRenderer).material.flow.noiseSpeed,
    light: { allocation: copiedLight.allocation.shrinkDelay, brightness: copiedLight.brightness },
  };
  gui.destroy();
  return result;
};
window.ready = true;
