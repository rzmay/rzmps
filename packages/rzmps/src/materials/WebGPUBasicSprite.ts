import * as THREE from 'three';
import MeshStandardNodeMaterial from 'three/src/materials/nodes/MeshStandardNodeMaterial.js';
import { cameraFar, cameraNear } from 'three/src/nodes/accessors/Camera.js';
import { attribute } from 'three/src/nodes/core/AttributeNode.js';
import { positionView } from 'three/src/nodes/accessors/Position.js';
import { texture } from 'three/src/nodes/accessors/TextureNode.js';
import { uv } from 'three/src/nodes/accessors/UV.js';
import { viewportUV } from 'three/src/nodes/display/ScreenNode.js';
import { perspectiveDepthToViewZ } from 'three/src/nodes/display/ViewportDepthNode.js';
import { abs, dot, smoothstep } from 'three/src/nodes/math/MathNode.js';
import { spritesheetUV } from 'three/src/nodes/utils/SpriteSheetUV.js';
import { float, vec2, vec3 } from 'three/src/nodes/tsl/TSLBase.js';
import { BasicSpriteOptions } from './BasicSprite';

type WebGPUBasicSpriteOptions = BasicSpriteOptions & {
  sceneDepthTexture: THREE.DepthTexture;
};

const WebGPUBasicSprite = (
  pointTexture: THREE.Texture, options: Partial<WebGPUBasicSpriteOptions> = {},
) => {
  const {
    gridSize,
    frames,
    alphaMap,
    normalMap,
    normalStrength,
    roughness,
    roughnessMap,
    envMap,
    envIntensity,
    normalLighting,
    sphericalNormals,
    softParticles,
    softParticleDistance,
    sceneDepthTexture,
    ...materialOptions
  } = options;

  const material = new MeshStandardNodeMaterial({
    depthTest: true,
    depthWrite: false,
    metalness: 0,
    roughness: roughness ?? 0.5,
    transparent: true,
    vertexColors: true,
    side: THREE.DoubleSide,
    ...materialOptions,
  } as THREE.MeshStandardMaterialParameters);

  const spriteUv = spritesheetUV(
    vec2(gridSize?.x ?? 1, gridSize?.y ?? 1),
    uv(),
    attribute('frame', 'float'),
  );
  const spriteColor = texture(pointTexture, spriteUv);
  let opacity = spriteColor.a.mul(attribute('instanceAlpha', 'float'));

  if (alphaMap) {
    opacity = opacity.mul(texture(alphaMap, spriteUv).r);
  }

  if (softParticleDistance && sceneDepthTexture) {
    const sceneViewZ = perspectiveDepthToViewZ(
      texture(sceneDepthTexture, viewportUV).r,
      cameraNear,
      cameraFar,
    );
    const particleViewZ = positionView.z;
    const fade = smoothstep(
      float(0),
      float(softParticleDistance),
      abs(particleViewZ.sub(sceneViewZ)),
    );

    opacity = opacity.mul(fade);
  }

  if (sphericalNormals) {
    const localUv = uv().mul(2).sub(1);
    const normalZ = float(1).sub(dot(localUv, localUv)).max(0).sqrt();

    material.normalNode = vec3(
      localUv.x,
      localUv.y,
      normalZ,
    ).normalize();
  }

  material.name = 'RZMPS WebGPU Basic Sprite';
  material.colorNode = spriteColor.rgb;
  material.opacityNode = opacity;
  material.alphaTest = 0.001;
  material.envMap = envMap ?? null;
  material.envMapIntensity = envIntensity ?? 1;
  material.roughnessNode = roughnessMap
    ? texture(roughnessMap, spriteUv).r.mul(roughness ?? 0.5)
    : float(roughness ?? 0.5);
  material.metalnessNode = float(0);
  material.userData.frames = frames ?? 1;
  material.userData.normalMap = normalMap;
  material.userData.normalStrength = normalStrength;
  material.userData.roughnessMap = roughnessMap;
  material.userData.normalLighting = normalLighting;
  material.userData.sphericalNormals = sphericalNormals;
  material.userData.softParticles = softParticles;
  material.userData.softParticleDistance = softParticleDistance;

  return material;
};

export default WebGPUBasicSprite;
