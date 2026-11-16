import { sceneColor, transmissionOutput, useSceneDepth } from './transmission.utils';
import type Appearance from '../compositing/Appearance';
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import type { UnlitSpriteOptions } from './unlitSprite';
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  cos,
  Fn,
  float,
  mix,
  normalView,
  perspectiveDepthToViewZ,
  positionView,
  viewportUV,
  sin,
  smoothstep,
  spritesheetUV,
  texture,
  uv,
  vec2,
} from 'three/tsl';

type WebGPUUnlitSpriteOptions = Omit<UnlitSpriteOptions, 'atlasInset'> & {
  atlasInset?: number | Node<'float'>;
  sceneDepthTexture: THREE.DepthTexture;
  spriteDataNode: Node<'vec4'>;
  colorNode: Node<'vec3'>;
  materialCopyNodes: ReturnType<Appearance['nodes']>;
};

type TSLMatrix4Node = {
  element: (index: number) => {
    element: (index: number) => ReturnType<typeof float>;
  };
};

const WebGPUUnlitSprite = (
  pointTexture: THREE.Texture, options: Partial<WebGPUUnlitSpriteOptions> = {},
) => {
  const {
    gridSize,
    atlasInset = 0,
    frames,
    alphaMap,
    softParticles,
    softParticleDistance,
    sceneDepthTexture,
    transmission,
    transmissionMap,
    distortionMap,
    distortionStrength,
    spriteDataNode,
    colorNode,
    materialCopyNodes,
    ...materialOptions
  } = options;
  const finalDistortionStrength = distortionStrength ?? (distortionMap ? 1 : 0);

  const material = new MeshBasicNodeMaterial({
    depthTest: true,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    ...materialOptions,
    vertexColors: colorNode === undefined,
  } as THREE.MeshBasicMaterialParameters);

  const spriteData = spriteDataNode ?? attribute('instanceSpriteData', 'vec4');
  const inset = typeof atlasInset === 'number' ? float(atlasInset) : atlasInset;
  const spriteUv = spritesheetUV(
    vec2(gridSize?.x ?? 1, gridSize?.y ?? 1),
    uv().mul(float(1).sub(inset.mul(2))).add(inset),
    spriteData.x,
  );

  const spriteColor = texture(pointTexture, spriteUv);
  let opacity = spriteColor.a.mul(spriteData.y);

  if (alphaMap) {
    const alphaSample = texture(alphaMap, spriteUv);
    opacity = opacity.mul(alphaSample.r).mul(alphaSample.a);
  }

  if (softParticleDistance && sceneDepthTexture) {
    const depthNode = texture(sceneDepthTexture, viewportUV);
    material.userData.sceneDepthNode = depthNode;
    const sceneViewZ = perspectiveDepthToViewZ(
      depthNode.r,
      cameraNear,
      cameraFar,
    );

    const particleViewZ = positionView.z;
    const fade = smoothstep(
      float(0),
      float(softParticleDistance),
      abs(particleViewZ.sub(sceneViewZ)),
    );

    // The supplied depth prepass belongs to the main camera, not the six reflection cameras.
    opacity = opacity.mul(mix(float(1), fade, useSceneDepth));
  }

  const finalAlpha = opacity.clamp(0, 1);

  material.name = 'RZMPS WebGPU Unlit Sprite';
  material.colorNode = colorNode ? spriteColor.rgb.mul(colorNode) : spriteColor.rgb;
  material.opacityNode = finalAlpha;
  material.alphaTest = 0.001;
  if (materialCopyNodes) {
    const result = materialCopyNodes.compositeGPU({ color: material.colorNode, opacity: finalAlpha,
      normal: normalView, roughness: float(1), metalness: float(0) }, spriteUv as Node<'vec2'>);
    material.colorNode = result.color;
    material.opacityNode = result.opacity;
  }

  const transmissionAmount = transmission ?? (transmissionMap ? 1 : 0);

  if (transmissionAmount > 0) {
    const baseTransmission = float(THREE.MathUtils.clamp(transmissionAmount, 0, 1));
    const transmissionValue = transmissionMap
      ? baseTransmission.mul(texture(transmissionMap, spriteUv).r)
      : baseTransmission;

    const transmittedColor = Fn(() => {
      if (!distortionMap || finalDistortionStrength === 0) {
        return sceneColor(viewportUV);
      }

      const particleDistortionStrength = spriteData.w;
      const rotation = spriteData.z;

      distortionMap.colorSpace = THREE.NoColorSpace;
      const distortionNormal = texture(distortionMap, spriteUv).xyz.mul(2).sub(1);
      const distortion = vec2(
        distortionNormal.x.mul(cos(rotation)).add(distortionNormal.y.mul(sin(rotation))),
        distortionNormal.y.mul(cos(rotation)).sub(distortionNormal.x.mul(sin(rotation))),
      );

      const projectionMatrix = cameraProjectionMatrix as unknown as TSLMatrix4Node;
      const isOrthographic = projectionMatrix.element(3).element(3).equal(1.0);
      const projectionScale = vec2(
        projectionMatrix.element(0).element(0),
        projectionMatrix.element(1).element(1),
      ).mul(0.5);
      const distortionPerspectiveScale = isOrthographic
        .select(float(1), positionView.z.negate().max(0.0001).reciprocal());
      const distortionWorldToUv = projectionScale.mul(distortionPerspectiveScale);

      const distortionUv = distortion
        .mul(float(finalDistortionStrength))
        .mul(particleDistortionStrength)
        .mul(finalAlpha)
        .mul(distortionWorldToUv);

      return sceneColor(viewportUV.add(distortionUv));
    })();

    material.outputNode = transmissionOutput(transmittedColor, transmissionValue, finalAlpha);
  }

  material.userData.frames = frames ?? 1;
  material.userData.softParticles = softParticles;
  material.userData.softParticleDistance = softParticleDistance;
  material.userData.transmission = transmissionAmount;
  material.userData.transmissionMap = transmissionMap;
  material.userData.distortionMap = distortionMap;
  material.userData.distortionStrength = finalDistortionStrength;

  return material;
};

export default WebGPUUnlitSprite;
