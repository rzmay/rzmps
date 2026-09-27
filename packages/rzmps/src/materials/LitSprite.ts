import * as THREE from 'three';
import litSpriteVert from '../shaders/LitSprite.vert';
import litSpriteFrag from '../shaders/LitSprite.frag';
import { UnlitSpriteOptions } from './UnlitSprite';

export interface LitSpriteOptions extends UnlitSpriteOptions, THREE.ShaderMaterialParameters {
  normalMap: THREE.Texture;
  normalStrength: number;
  normalLighting: number;
  sphericalNormals: number;
  roughness: number;
  roughnessMap: THREE.Texture;
  metalness: number;
  metalnessMap: THREE.Texture;
  envMap: THREE.Texture;
  envIntensity: number;
}

const LitSprite = (
  texture: THREE.Texture, options: Partial<LitSpriteOptions> = {},
) => {
  const {
    gridSize,
    frames,
    alphaMap,
    normalMap,
    normalStrength = 1,
    normalLighting,
    sphericalNormals,
    roughness = 0.5,
    roughnessMap,
    metalness = 0,
    metalnessMap,
    envMap,
    envIntensity = 1.0,
    softParticleDistance = 0,
    transmission,
    transmissionMap,
    distortionMap,
    distortionStrength,
    ...materialOptions
  } = options;

  return new THREE.ShaderMaterial({
    vertexShader: litSpriteVert,
    fragmentShader: litSpriteFrag,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.lights,
      {
        pointTexture: { value: texture },

        gridSize: { value: gridSize ?? { x: 1, y: 1 } },
        n_frames: { value: frames ?? 1 },

        alphaMap: { value: alphaMap ?? null },
        hasAlphaMap: { value: Boolean(alphaMap) },

        normalMap: { value: normalMap ?? null },
        hasNormalMap: { value: Boolean(normalMap) },
        normalStrength: { value: normalStrength },

        // Normal lighting, if not already set, defaults to 1 if there is a normal map present and 0 if not.
        normalLighting: { value: normalLighting ?? (normalMap ? 1 : 0) },
        sphericalNormals: { value: normalizeSphericalNormals(sphericalNormals) },

        roughness: { value: roughness },
        roughnessMap: { value: roughnessMap ?? null },
        hasRoughnessMap: { value: Boolean(roughnessMap) },
        metalness: { value: THREE.MathUtils.clamp(metalness, 0, 1) },
        metalnessMap: { value: metalnessMap ?? null },
        hasMetalnessMap: { value: Boolean(metalnessMap) },

        envMap: { value: envMap },
        envIntensity: { value: envIntensity },
        hasEnvMap: { value: Boolean(envMap) },

        transmission: { value: transmission ?? (transmissionMap ? 1 : 0) },
        transmissionMap: { value: transmissionMap ?? null },
        hasTransmissionMap: { value: Boolean(transmissionMap) },
        distortionMap: { value: distortionMap ?? normalMap ?? null },
        hasDistortionMap: { value: Boolean(distortionMap ?? normalMap) },
        distortionStrength: { value: distortionStrength ?? normalStrength ?? (distortionMap ?? normalMap ? 1 : 0) },

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
    ]),

    depthTest: true,
    depthWrite: false,
    lights: true,
    transparent: true,
    vertexColors: true,
    ...materialOptions,
  });
};

function normalizeSphericalNormals(value: number | boolean | undefined): number {
  return THREE.MathUtils.clamp(Number(value ?? 0), 0, 1);
}

export default LitSprite;
