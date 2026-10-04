import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import type { UnlitSpriteOptions } from './UnlitSprite';
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cos,
  Fn,
  float,
  mix,
  output,
  perspectiveDepthToViewZ,
  positionView,
  viewportSize,
  viewportUV,
  sin,
  smoothstep,
  spritesheetUV,
  texture,
  uv,
  vec2,
  vec4,
  viewportSharedTexture,
} from 'three/tsl';

type WebGPUUnlitSpriteOptions = UnlitSpriteOptions & {
  sceneDepthTexture: THREE.DepthTexture;
  spriteDataNode: Node<'vec4'>;
  colorNode: Node<'vec3'>;
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
    transmission,
    transmissionMap,
    distortionMap,
    distortionStrength,
    spriteDataNode,
    colorNode,
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

  const spriteData = spriteDataNode ?? attribute('instanceSpriteData', 'vec4');
  const particleColor = colorNode ?? attribute('instanceColor', 'vec3');
  const spriteUv = spritesheetUV(
    vec2(gridSize?.x ?? 1, gridSize?.y ?? 1),
    uv(),
    spriteData.x,
  );

  const spriteColor = texture(pointTexture, spriteUv);
  let opacity = spriteColor.a.mul(spriteData.y);

  if (alphaMap) {
    const alphaSample = texture(alphaMap, spriteUv);
    opacity = opacity.mul(alphaSample.r).mul(alphaSample.a);
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

  const finalAlpha = opacity.clamp(0, 1).toVar();

  material.name = 'RZMPS WebGPU Unlit Sprite';
  material.colorNode = spriteColor.rgb.mul(particleColor);
  material.opacityNode = finalAlpha;
  material.alphaTest = 0.001;

  const transmissionAmount = transmission ?? (transmissionMap ? 1 : 0);

  if (transmissionAmount > 0) {
    const baseTransmission = float(THREE.MathUtils.clamp(transmissionAmount, 0, 1));
    const transmissionValue = transmissionMap
      ? baseTransmission.mul(texture(transmissionMap, spriteUv).r)
      : baseTransmission;

    const transmittedColor = Fn(() => {
      if (!distortionMap || distortionStrength === 0) {
        return viewportSharedTexture(viewportUV).rgb;
      }

      const particleDistortionStrength = spriteData.w;
      const rotation = spriteData.z;

      distortionMap.colorSpace = THREE.NoColorSpace;
      const distortionNormal = texture(distortionMap, spriteUv).xyz.mul(2).sub(1);
      const distortion = vec2(
        distortionNormal.x.mul(cos(rotation)).add(distortionNormal.y.mul(sin(rotation))),
        distortionNormal.y.mul(cos(rotation)).sub(distortionNormal.x.mul(sin(rotation))),
      );

      const distortionPixels = distortion
        .mul(float(distortionStrength))
        .mul(particleDistortionStrength)
        .mul(finalAlpha)
        .mul(float(4)); // Balancing -- for some reason its 4x weaker

      const distortionUv = distortionPixels.div(viewportSize);

      return viewportSharedTexture(
        viewportUV.add(distortionUv),
      ).rgb;
    })();

    const finalTransmisison = float(1.0).sub(finalAlpha.mul(float(1.0).sub(transmissionValue)));

    material.outputNode = vec4(
      mix(output.rgb, transmittedColor, finalTransmisison),
      float(1.0),
    );
  }

  material.userData.frames = frames ?? 1;
  material.userData.softParticles = softParticles;
  material.userData.softParticleDistance = softParticleDistance;
  material.userData.transmission = transmissionAmount;
  material.userData.transmissionMap = transmissionMap;
  material.userData.distortionMap = distortionMap;
  material.userData.distortionStrength = distortionStrength;

  return material;
};

export default WebGPUUnlitSprite;
