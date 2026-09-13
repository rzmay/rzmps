import * as THREE from 'three';
import MeshBasicNodeMaterial from 'three/src/materials/nodes/MeshBasicNodeMaterial.js';
import { cameraFar, cameraNear } from 'three/src/nodes/accessors/Camera.js';
import { attribute } from 'three/src/nodes/core/AttributeNode.js';
import { positionView } from 'three/src/nodes/accessors/Position.js';
import { texture } from 'three/src/nodes/accessors/TextureNode.js';
import { uv } from 'three/src/nodes/accessors/UV.js';
import { viewportUV } from 'three/src/nodes/display/ScreenNode.js';
import { perspectiveDepthToViewZ } from 'three/src/nodes/display/ViewportDepthNode.js';
import { abs, smoothstep } from 'three/src/nodes/math/MathNode.js';
import { spritesheetUV } from 'three/src/nodes/utils/SpriteSheetUV.js';
import { float, vec2 } from 'three/src/nodes/tsl/TSLBase.js';
import { UnlitSpriteOptions } from './UnlitSprite';

type WebGPUUnlitSpriteOptions = UnlitSpriteOptions & {
  sceneDepthTexture: THREE.DepthTexture;
};

const WebGPUUnlitSprite = (
  pointTexture: THREE.Texture, options: Partial<WebGPUUnlitSpriteOptions> = {},
) => {
  const {
    gridSize,
    frames,
    alphaMap,
    softParticles,
    softParticleDistance,
    sceneDepthTexture,
    ...materialOptions
  } = options;

  const material = new MeshBasicNodeMaterial({
    depthTest: true,
    depthWrite: false,
    transparent: true,
    vertexColors: true,
    side: THREE.DoubleSide,
    ...materialOptions,
  } as THREE.MeshBasicMaterialParameters);

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

  material.name = 'RZMPS WebGPU Unlit Sprite';
  material.colorNode = spriteColor.rgb;
  material.opacityNode = opacity;
  material.alphaTest = 0.001;
  material.userData.frames = frames ?? 1;
  material.userData.softParticles = softParticles;
  material.userData.softParticleDistance = softParticleDistance;

  return material;
};

export default WebGPUUnlitSprite;
