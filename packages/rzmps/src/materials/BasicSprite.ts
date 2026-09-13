import * as THREE from 'three';
import basicSpriteVert from '../shaders/BasicSprite.vert';
import basicSpriteFrag from '../shaders/BasicSprite.frag';

export interface BasicSpriteOptions extends THREE.ShaderMaterialParameters {
  gridSize: {x: number, y: number};
  frames: number;
  alphaMap: THREE.Texture;
  normalMap: THREE.Texture;
  normalStrength: number;
  normalLighting: number;
  sphericalNormals: boolean;
  roughness: number;
  roughnessMap: THREE.Texture;
  envMap: THREE.Texture;
  envIntensity: number;
  softParticles: boolean;
  softParticleDistance: number;
}

const BasicSprite = (
  texture: THREE.Texture, options: Partial<BasicSpriteOptions> = {},
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
    envMap,
    envIntensity = 1.0,
    softParticles,
    softParticleDistance = 0,
    ...materialOptions
  } = options;

  return new THREE.ShaderMaterial({
    vertexShader: basicSpriteVert,
    fragmentShader: basicSpriteFrag,
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
        sphericalNormals: { value: sphericalNormals ?? false },

        roughness: { value: roughness },
        roughnessMap: { value: roughnessMap ?? null },
        hasRoughnessMap: { value: Boolean(roughnessMap) },

        envMap: { value: envMap },
        envIntensity: { value: envIntensity },
        hasEnvMap: { value: Boolean(envMap) },

        softParticles: { value: Boolean(softParticleDistance) },
        softParticleDistance: { value: softParticleDistance },
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

export default BasicSprite;
