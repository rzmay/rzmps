/* eslint-disable react/no-unknown-property */
import React, { useCallback, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stats } from '@react-three/drei';
import * as THREE from 'three';
import WebGPURenderer from 'three/src/renderers/webgpu/WebGPURenderer.js';
import AmbientLightNode from 'three/src/nodes/lighting/AmbientLightNode.js';
import DirectionalLightNode from 'three/src/nodes/lighting/DirectionalLightNode.js';
import HemisphereLightNode from 'three/src/nodes/lighting/HemisphereLightNode.js';
import PointLightNode from 'three/src/nodes/lighting/PointLightNode.js';
import RectAreaLightNode from 'three/src/nodes/lighting/RectAreaLightNode.js';
import SpotLightNode from 'three/src/nodes/lighting/SpotLightNode.js';
import CameraControls from '../components/CameraControls';
import ParticleSystemDisplay from '../components/ParticleSystemDisplay';
import particlePresets from '../presets/particles';
import scenePresets from '../presets/scenes';

const RENDERER_MODES = ['webgl', 'webgpu'];
const PARTICLE_PRESET_NAMES = Object.keys(particlePresets);
const SCENE_PRESET_NAMES = Object.keys(scenePresets);

function getQueryParam(name, allowedValues, fallback) {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(name);

  return allowedValues.includes(value) ? value : fallback;
}

function setQueryParam(name, value) {
  const url = new URL(window.location.href);

  url.searchParams.set(name, value);
  window.history.replaceState({}, '', url);
}

async function createWebGPURenderer(defaultProps) {
  const renderer = new WebGPURenderer(defaultProps);

  renderer.library.addLight(AmbientLightNode, THREE.AmbientLight);
  renderer.library.addLight(DirectionalLightNode, THREE.DirectionalLight);
  renderer.library.addLight(HemisphereLightNode, THREE.HemisphereLight);
  renderer.library.addLight(PointLightNode, THREE.PointLight);
  renderer.library.addLight(RectAreaLightNode, THREE.RectAreaLight);
  renderer.library.addLight(SpotLightNode, THREE.SpotLight);

  await renderer.init();

  return renderer;
}

function DemoScene({
  onCodeChange,
  onPresetChange,
  onRendererChange,
  onSceneChange,
  onShowCodeChange,
  particlePreset,
  rendererMode,
  scenePreset,
}) {
  return (
    <>
      <Stats />
      <CameraControls />
      <ParticleSystemDisplay
        initialPreset={particlePreset}
        initialScene={scenePreset}
        onCodeChange={onCodeChange}
        onPresetChange={onPresetChange}
        onRendererChange={onRendererChange}
        onSceneChange={onSceneChange}
        onShowCodeChange={onShowCodeChange}
        rendererMode={rendererMode}
      />
    </>
  );
}

function IndexPage() {
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [rendererMode, setRendererMode] = useState(() => (
    getQueryParam('renderer', RENDERER_MODES, 'webgl')
  ));
  const [particlePreset, setParticlePreset] = useState(() => (
    getQueryParam('preset', PARTICLE_PRESET_NAMES, 'Fire')
  ));
  const [scenePreset, setScenePreset] = useState(() => (
    getQueryParam('scene', SCENE_PRESET_NAMES, 'Checkerboard')
  ));

  const handleRendererChange = useCallback((nextRendererMode) => {
    setQueryParam('renderer', nextRendererMode);
    setRendererMode(nextRendererMode);
  }, []);

  const handlePresetChange = useCallback((name) => {
    setQueryParam('preset', name);
    setParticlePreset(name);
  }, []);

  const handleSceneChange = useCallback((name) => {
    setQueryParam('scene', name);
    setScenePreset(name);
  }, []);

  return (
    <div className="demo-shell">
      <Canvas
        key={rendererMode}
        gl={rendererMode === 'webgpu' ? createWebGPURenderer : undefined}
        onCreated={({ gl }) => gl.setClearColor('#202020')}
        shadows
      >
        <DemoScene
          onCodeChange={setCode}
          onPresetChange={handlePresetChange}
          onRendererChange={handleRendererChange}
          onSceneChange={handleSceneChange}
          onShowCodeChange={setShowCode}
          particlePreset={particlePreset}
          rendererMode={rendererMode}
          scenePreset={scenePreset}
        />
      </Canvas>

      {showCode && (
        <pre className="code-panel">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export default IndexPage;
