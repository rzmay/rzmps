import { profileRenderer } from '@rzmps/rzmps';
import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { useFrame, useThree } from '@react-three/fiber';
import { FluidSimulation } from '@rzmps/rzmps';
import { ParticleSystemGUI } from '../gui/ParticleSystemGUI';
import standardPresets from 'examples/index.js';
import experimentalPresets from 'examples/experimental/index.js';
import scenePresets from 'examples/scenes/index.js';
import { getSceneParticleRoot } from 'examples/utils/particleRoot.js';

const particlePresets = { ...standardPresets, ...experimentalPresets };

const RZMPS_VERSION = import.meta.env.VITE_RZMPS_VERSION;

function formatBounds(bounds) {
  if (!bounds || bounds.isEmpty()) return 'empty';
  const vector = (value) => [value.x, value.y, value.z]
    .map((component) => component.toFixed(2)).join(', ');
  return `[${vector(bounds.min)}] to [${vector(bounds.max)}]`;
}

function collectSystemStats(system, visited = new Set()) {
  if (!system || visited.has(system)) {
    return {
      particles: 0,
      children: 0,
      allocated: 0,
      activeSlots: 0,
      fluidBounds: [],
    };
  }

  visited.add(system);

  const stats = {
    particles: system.liveParticleCount ?? system.particles?.filter(particle => particle.alive).length ?? 0,
    children: system.renderers?.reduce((count, renderer) => count + renderer.renderedChildCount, 0) ?? 0,
    allocated: system.isGPUProcessingActive ? (system.gpuBufferStats?.allocated ?? 0) : 0,
    activeSlots: system.isGPUProcessingActive ? (system.gpuBufferStats?.activeSlots ?? 0) : 0,
    fluidBounds: system.modules
      ?.filter((module) => module instanceof FluidSimulation)
      .map((module) => ({
        name: module.constructor.name.replace('Simulation', ''),
        particles: formatBounds(module.particleBounds),
        grid: formatBounds(module.bounds),
        padding: module.automaticPadding
          ? `auto [${module.automaticPaddingDistance.toArray().map(value => value.toFixed(2)).join(', ')}]`
          : `manual ${module.boundsPadding.toFixed(2)}`,
      })) ?? [],
  };

  system.subSystems?.forEach((_options, subSystem) => {
    const childStats = collectSystemStats(subSystem, visited);
    stats.particles += childStats.particles;
    stats.children += childStats.children;
    stats.allocated += childStats.allocated;
    stats.activeSlots += childStats.activeSlots;
    stats.fluidBounds.push(...childStats.fluidBounds);
  });


  return stats;
}

function ParticleSystemDisplay({
  initialPreset,
  initialScene,
  onCodeChange,
  onMetadataChange,
  onParticleCountChange,
  onPresetChange,
  onRendererChange,
  onSceneChange,
  onShowCodeChange,
  rendererMode,
}) {
  const particleSystem = useRef(null);
  const guiRef = useRef(null);
  const preparations = useRef(new WeakMap());
  const selectionRef = useRef(null);
  selectionRef.current = { preset: initialPreset, scene: initialScene };
  useEffect(() => {
    const gui = guiRef.current;
    if (!gui) return;
    if (gui.currentPresetName !== initialPreset) void gui.loadPreset(initialPreset);
    if (gui.currentSceneName !== initialScene) void gui.setScene(initialScene);
  }, [initialPreset, initialScene]);
  const initialSettings = useRef(null);
  initialSettings.current = { initialPreset, initialScene, rendererMode };
  const { gl, scene } = useThree();

  useEffect(() => {
    let cancelled = false;
    const { initialPreset, initialScene, rendererMode } = initialSettings.current;

    async function initialize() {
      const system = await particlePresets[initialPreset].create();

      if (cancelled) {
        system.destroy();
        return;
      }

      particleSystem.current = system;
      getSceneParticleRoot(scene).add(system);

      const gui = new ParticleSystemGUI({
        system,
        scene,
        presets: particlePresets,
        scenes: scenePresets,
        renderer: gl,
        initialPreset,
        initialScene,
        title: `🧅 RZMPS Demo v${RZMPS_VERSION}`,
        width: 340,
        beforeSceneChange: async () => {
          const preparation = preparations.current.get(particleSystem.current);
          await preparation?.promise;
          if (preparation) { preparation.ready = false; preparation.promise = undefined; }
        },
        onSystemChange: nextSystem => {
          particleSystem.current = nextSystem;
        },
        onCodeChange,
        onMetadataChange,
        onPresetChange,
        onRendererChange,
        onSceneChange,
        onShowCodeChange,
        rendererMode,
      });

      guiRef.current = gui;
      const selection = selectionRef.current;
      if (selection.preset !== initialPreset) void gui.loadPreset(selection.preset);
      if (selection.scene !== initialScene) void gui.setScene(selection.scene);
    }

    initialize();

    return () => {
      cancelled = true;
      guiRef.current?.destroy();
      guiRef.current = null;

      if (particleSystem.current) {
        particleSystem.current.destroy();
        particleSystem.current = null;
      }
    };
  }, [onCodeChange, onMetadataChange, onPresetChange, onRendererChange, onSceneChange, onShowCodeChange, gl, scene]);

  useFrame((_state, delta) => {
    const system = particleSystem.current;
    const requiresGPU = system?.modules.some((module) => module instanceof FluidSimulation);
    const rendererReady = !guiRef.current?.sceneLoading && system?.sceneRenderer === gl
      && (!requiresGPU || (system.gpuProcessing && gl.backend?.isWebGPUBackend === true));
    if (rendererReady && requiresGPU) {
      let preparation = preparations.current.get(system);
      if (!preparation) {
        preparation = { ready: false, started: false };
        preparations.current.set(system, preparation);
      }
      if (!preparation.promise) {
        preparation.promise = system.prepare(gl).then(() => {
          if (particleSystem.current !== system) return;
          // Rebase the initial emission clock after non-advancing preparation.
          if (!preparation.started && system.playing && !system.paused) system.start(false);
          preparation.started = true;
          preparation.ready = true;
        }).catch(error => { console.error('Fluid resource preparation failed:', error); });
      }
      if (preparation.ready) system.update();
    } else if (rendererReady) system.update();
    onParticleCountChange(collectSystemStats(particleSystem.current));
    guiRef.current?.update(delta);
  });

  // Keep the normal update-before-render order; this callback owns the one default scene render.
  useFrame(({ gl, scene, camera }, delta) => {
    profileRenderer(particleSystem.current?.benchmarks, gl, () => gl.render(scene, camera), delta * 1000);
  }, 1);

  return null;
}

ParticleSystemDisplay.propTypes = {
  initialPreset: PropTypes.string.isRequired,
  initialScene: PropTypes.string.isRequired,
  onCodeChange: PropTypes.func.isRequired,
  onMetadataChange: PropTypes.func.isRequired,
  onParticleCountChange: PropTypes.func.isRequired,
  onPresetChange: PropTypes.func.isRequired,
  onRendererChange: PropTypes.func.isRequired,
  onSceneChange: PropTypes.func.isRequired,
  onShowCodeChange: PropTypes.func.isRequired,
  rendererMode: PropTypes.oneOf(['webgl', 'webgpu']).isRequired,
};

export default ParticleSystemDisplay;
