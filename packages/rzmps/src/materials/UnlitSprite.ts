import * as THREE from 'three';
import unlitSpriteVert from '../shaders/UnlitSprite.vert';
import unlitSpriteFrag from '../shaders/UnlitSprite.frag';

export interface UnlitSpriteOptions {
  gridSize: {x: number, y: number};
  frames: number;
  alphaMap: THREE.Texture;
  softParticles: boolean;
  softParticleDistance: number;
}

const UnlitSprite = (
  texture: THREE.Texture, options: Partial<UnlitSpriteOptions> = {},
) => {
  const {
    gridSize,
    frames,
    alphaMap,
    softParticles,
    softParticleDistance = 0,
    ...materialOptions
  } = options;

  return new THREE.ShaderMaterial({
    vertexShader: unlitSpriteVert,
    fragmentShader: unlitSpriteFrag,
    uniforms: {
      pointTexture: { value: texture },
      gridSize: { value: gridSize ?? { x: 1, y: 1 } },
      n_frames: { value: frames ?? 1 },
      alphaMap: { value: alphaMap ?? null },
      hasAlphaMap: { value: Boolean(alphaMap) },
      softParticles: { value: Boolean(softParticleDistance) },
      softParticleDistance: { value: softParticleDistance },
      sceneDepthTexture: { value: null },
      depthResolution: { value: new THREE.Vector2() },
      depthCameraNear: { value: 0.1 },
      depthCameraFar: { value: 2000 },
    },

    depthTest: true,
    depthWrite: false,
    transparent: true,
    vertexColors: true,

    ...materialOptions,
  });
};

export default UnlitSprite;
