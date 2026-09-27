import * as THREE from 'three';
import unlitSpriteVert from '../shaders/UnlitSprite.vert';
import unlitSpriteFrag from '../shaders/UnlitSprite.frag';

// TODO: Should all maps be animated? Distortion?
export interface UnlitSpriteOptions {
  gridSize: {x: number, y: number};
  frames: number;
  alphaMap: THREE.Texture;
  softParticles: boolean;
  softParticleDistance: number;
  distortionMap: THREE.Texture;
  distortionStrength: number;
  transmission: number;
  transmissionMap: THREE.Texture;
}

const UnlitSprite = (
  texture: THREE.Texture, options: Partial<UnlitSpriteOptions> = {},
) => {
  const {
    gridSize,
    frames,
    alphaMap,
    softParticleDistance = 0,
    transmission,
    transmissionMap,
    distortionMap,
    distortionStrength,
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

      transmission: { value: transmission ?? (transmissionMap ? 1 : 0) },
      transmissionMap: { value: transmissionMap ?? null },
      hasTransmissionMap: { value: Boolean(transmissionMap) },
      distortionMap: { value: distortionMap ?? null },
      hasDistortionMap: { value: Boolean(distortionMap) },
      distortionStrength: { value: distortionStrength ?? (distortionMap ? 1 : 0) },

      softParticles: { value: Boolean(softParticleDistance) },
      softParticleDistance: { value: softParticleDistance },
      viewportHeight: { value: 600 },
      sizeAttenuation: { value: true },

      sceneColorTexture: { value: null },
      sceneColorResolution: { value: new THREE.Vector2(1, 1) },

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
