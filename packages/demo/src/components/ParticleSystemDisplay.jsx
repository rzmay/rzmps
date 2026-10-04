import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { useFrame, useThree } from '@react-three/fiber';
import { ParticleSystemGUI } from '../gui/ParticleSystemGUI';
import particlePresets from '../presets/particles';
import scenePresets from '../presets/scenes';
import { getSceneParticleRoot } from '../presets/scenes/particleRoot';

const RZMPS_VERSION = import.meta.env.VITE_RZMPS_VERSION;

function collectSystemStats(system, visited = new Set()) {
  if (!system || visited.has(system)) {
    return {
      particles: 0,
      allocated: 0,
      activeSlots: 0,
    };
  }

  visited.add(system);

  const stats = {
    particles: system.liveParticleCount ?? system.particles?.filter((particle) => particle.alive).length ?? 0,
    allocated: system.gpuBufferStats?.allocated ?? 0,
    activeSlots: system.gpuBufferStats?.activeSlots ?? 0,
  };

  system.subSystems?.forEach((_options, subSystem) => {
    const childStats = collectSystemStats(subSystem, visited);
    stats.particles += childStats.particles;
    stats.allocated += childStats.allocated;
    stats.activeSlots += childStats.activeSlots;
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
  const { gl, scene } = useThree();

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      const system = await particlePresets[initialPreset]();

      if (cancelled) return;

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
        title: `RZMPS Demo v${RZMPS_VERSION}`,
        width: 340,
        onSystemChange: (nextSystem) => {
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
  }, [
    onCodeChange,
    onMetadataChange,
    onPresetChange,
    onRendererChange,
    onSceneChange,
    onShowCodeChange,
    gl,
    scene,
  ]);

  useFrame((_state, delta) => {
    particleSystem.current?.update();
    onParticleCountChange(collectSystemStats(particleSystem.current));
    guiRef.current?.update(delta);
  });

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
