/* eslint-disable react/no-unknown-property */
import React, { useCallback, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Stats } from '@react-three/drei';
import * as THREE from 'three';
import {
  AmbientLightNode,
  DirectionalLightNode,
  HemisphereLightNode,
  PointLightNode,
  RectAreaLightNode,
  SpotLightNode,
  WebGPURenderer,
} from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/examples/jsm/lights/RectAreaLightTexturesLib.js';
import CameraControls from '../components/CameraControls';
import ParticleSystemDisplay from '../components/ParticleSystemDisplay';
import particlePresets from '../presets/particles';
import scenePresets from '../presets/scenes';
import BenchmarkPage from './BenchmarkPage';

const RENDERER_MODES = ['webgl', 'webgpu'];
const PARTICLE_PRESET_NAMES = Object.keys(particlePresets);
const SCENE_PRESET_NAMES = Object.keys(scenePresets);

function getPresetMetadata(presets, name) {
  const entry = presets[name];
  const factory = typeof entry === 'function' ? entry : entry?.create;

  return {
    sourceUrl: entry?.sourceUrl ?? factory?.sourceUrl,
    author: entry?.author ?? factory?.author,
    description: entry?.description ?? factory?.description,
  };
}

function getGithubAvatar(author) {
  const normalized = normalizeAuthor(author);
  if (!normalized?.url) return undefined;

  const match = normalized.url.match(/^https:\/\/github\.com\/([^/?#]+)/);
  return match ? `https://github.com/${match[1]}.png?size=64` : undefined;
}

function normalizeAuthor(author) {
  if (!author) return undefined;

  if (typeof author === 'string') {
    return {
      name: author,
      url: `https://github.com/${author}`,
    };
  }

  return author;
}

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

  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

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
  onMetadataChange,
  onParticleCountChange,
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
        onMetadataChange={onMetadataChange}
        onParticleCountChange={onParticleCountChange}
        onPresetChange={onPresetChange}
        onRendererChange={onRendererChange}
        onSceneChange={onSceneChange}
        onShowCodeChange={onShowCodeChange}
        rendererMode={rendererMode}
      />
    </>
  );
}

function PresetAttribution({ metadata }) {
  const particleAuthor = normalizeAuthor(metadata.particle?.author);
  const sceneAuthor = normalizeAuthor(metadata.scene?.author);
  const particleAvatar = getGithubAvatar(particleAuthor);
  const sceneAvatar = getGithubAvatar(sceneAuthor);
  const descriptions = [
    metadata.particle?.description,
    metadata.scene?.description,
  ].filter(Boolean);

  return (
    <div className="preset-attribution" aria-label="Preset attribution">
      {descriptions.length > 0 && (
        <div className="preset-attribution-description">
          {descriptions.join(' ')}
        </div>
      )}

      <div className="preset-attribution-authors">
        {particleAuthor?.url && (
          <a href={particleAuthor.url} target="_blank" rel="noreferrer" className="preset-attribution-author">
            {particleAvatar && <img src={particleAvatar} alt="" />}
            <span>Particle system by {particleAuthor.name}</span>
          </a>
        )}

        {sceneAuthor?.url && (
          <a href={sceneAuthor.url} target="_blank" rel="noreferrer" className="preset-attribution-author">
            {sceneAvatar && <img src={sceneAvatar} alt="" />}
            <span>Scene by {sceneAuthor.name}</span>
          </a>
        )}
      </div>

      <div className="preset-attribution-sources">
        {metadata.particle?.sourceUrl && (
          <a href={metadata.particle.sourceUrl} target="_blank" rel="noreferrer">
            Particle source
          </a>
        )}
        {metadata.scene?.sourceUrl && (
          <a href={metadata.scene.sourceUrl} target="_blank" rel="noreferrer">
            Scene source
          </a>
        )}
      </div>
    </div>
  );
}

function DemoPage() {
  const [code, setCode] = useState('');
  const particleCountRef = useRef(null);
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
  const [metadata, setMetadata] = useState(() => ({
    particle: getPresetMetadata(particlePresets, particlePreset),
    scene: getPresetMetadata(scenePresets, scenePreset),
  }));

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

  const handleParticleCountChange = useCallback((stats) => {
    if (particleCountRef.current) {
      const count = typeof stats === 'number' ? stats : stats.particles;
      const allocated = typeof stats === 'number' ? 0 : stats.allocated;
      const activeSlots = typeof stats === 'number' ? 0 : stats.activeSlots;
      const usage = allocated > 0 ? (count / allocated) * 100 : 0;
      const lines = [`${count.toLocaleString()} particles`];

      if (allocated > 0) {
        lines.push(`${allocated.toLocaleString()} GPU slots, ${usage.toFixed(1)}% live`);
      } else if (activeSlots > 0) {
        lines.push(`${activeSlots.toLocaleString()} active slots`);
      }

      particleCountRef.current.textContent = lines.join('\n');
    }
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
          onMetadataChange={setMetadata}
          onParticleCountChange={handleParticleCountChange}
          onPresetChange={handlePresetChange}
          onRendererChange={handleRendererChange}
          onSceneChange={handleSceneChange}
          onShowCodeChange={setShowCode}
          particlePreset={particlePreset}
          rendererMode={rendererMode}
          scenePreset={scenePreset}
        />
      </Canvas>

      <div ref={particleCountRef} className="particle-count-monitor">0 particles</div>

      <PresetAttribution metadata={metadata} />

      {showCode && (
        <pre className="code-panel">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function IndexPage() {
  if (new URLSearchParams(window.location.search).get('benchmark') === '1') {
    return <BenchmarkPage />;
  }

  return <DemoPage />;
}

export default IndexPage;
