import { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { useFrame, useThree } from '@react-three/fiber';
import { ParticleSystemGUI } from '../gui/ParticleSystemGUI';
import particlePresets from '../presets/particles';
import scenePresets from '../presets/scenes';

function ParticleSystemDisplay({
  initialPreset,
  initialScene,
  onCodeChange,
  onPresetChange,
  onRendererChange,
  onSceneChange,
  onShowCodeChange,
  rendererMode,
}) {
  const particleSystem = useRef(null);
  const guiRef = useRef(null);
  const { scene } = useThree();

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      const system = await particlePresets[initialPreset]();

      if (cancelled) return;

      particleSystem.current = system;
      scene.add(system);

      const gui = new ParticleSystemGUI({
        system,
        scene,
        presets: particlePresets,
        scenes: scenePresets,
        initialPreset,
        initialScene,
        title: 'RZMPS Demo',
        width: 340,
        onSystemChange: (nextSystem) => {
          particleSystem.current = nextSystem;
        },
        onCodeChange,
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
        scene.remove(particleSystem.current);
        particleSystem.current = null;
      }
    };
  }, [
    onCodeChange,
    onPresetChange,
    onRendererChange,
    onSceneChange,
    onShowCodeChange,
    scene,
  ]);

  useFrame(() => {
    particleSystem.current?.update();
  });

  return null;
}

ParticleSystemDisplay.propTypes = {
  initialPreset: PropTypes.string.isRequired,
  initialScene: PropTypes.string.isRequired,
  onCodeChange: PropTypes.func.isRequired,
  onPresetChange: PropTypes.func.isRequired,
  onRendererChange: PropTypes.func.isRequired,
  onSceneChange: PropTypes.func.isRequired,
  onShowCodeChange: PropTypes.func.isRequired,
  rendererMode: PropTypes.oneOf(['webgl', 'webgpu']).isRequired,
};

export default ParticleSystemDisplay;
