import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraFar,
  cameraNear,
  cameraProjectionMatrix,
  clamp,
  cos,
  dot,
  float,
  Fn,
  mix,
  output,
  perspectiveDepthToViewZ,
  positionView,
  sin,
  smoothstep,
  spritesheetUV,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
  viewportUV,
} from 'three/tsl';
import type { LitSpriteOptions } from './LitSprite';

type WebGPULitSpriteOptions = LitSpriteOptions & {
  sceneDepthTexture: THREE.DepthTexture;
  spriteDataNode: Node<'vec4'>;
  colorNode: Node<'vec3'>;
};

type TSLMatrix4Node = {
  element: (index: number) => {
    element: (index: number) => ReturnType<typeof float>;
  };
};

const WebGPULitSprite = (
  pointTexture: THREE.Texture, options: Partial<WebGPULitSpriteOptions> = {},
) => {
  const {
    gridSize,
    frames,
    alphaMap,
    normalMap,
    normalStrength = 1,
    roughness,
    roughnessMap,
    metalness = 0,
    metalnessMap,
    envMap,
    envIntensity,
    normalLighting,
    sphericalNormals,
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

  const finalDistortionMap = distortionMap ?? normalMap;
  const finalDistortionStrength = distortionStrength ?? (finalDistortionMap ? 1 : 0);

  const material = new MeshStandardNodeMaterial({
    depthTest: true,
    depthWrite: false,
    metalness,
    roughness: roughness ?? 0.5,
    transparent: true,
    vertexColors: true,
    side: THREE.DoubleSide,
    ...materialOptions,
  } as THREE.MeshStandardMaterialParameters);

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

  const sphericalNormalsAmount = THREE.MathUtils.clamp(Number(sphericalNormals ?? 0), 0, 1);

  // TSL node expressions narrow to different concrete node classes after each
  // operation, but they are all valid vec3 nodes for material.normalNode.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let normalNode: any = vec3(0, 0, 1);

  if (sphericalNormalsAmount > 0) {
    const localUv = uv().mul(2).sub(1);
    const normalZ = float(1).sub(dot(localUv, localUv)).max(0).sqrt();
    const sphereNormal = vec3(localUv.x, localUv.y, normalZ).normalize();

    normalNode = mix(
      normalNode,
      sphereNormal,
      clamp(float(sphericalNormalsAmount), 0, 1),
    ).normalize();
  }

  if (normalMap && normalStrength > 0) {
    const rotation = spriteData.z;
    const mapNormalSample = texture(normalMap, spriteUv).xyz.mul(2).sub(1);
    const mapNormalX = mapNormalSample.x.mul(cos(rotation)).add(mapNormalSample.y.mul(sin(rotation)));
    const mapNormalY = mapNormalSample.y.mul(cos(rotation)).sub(mapNormalSample.x.mul(sin(rotation)));
    const mapNormal = vec3(
      mapNormalX.mul(float(normalStrength)),
      mapNormalY.mul(float(normalStrength)),
      mapNormalSample.z,
    ).normalize();

    normalNode = normalNode.mul(mapNormal).normalize();
  }

  if (sphericalNormalsAmount > 0 || (normalMap && normalStrength > 0)) {
    material.normalNode = normalNode;
  }

  const finalAlpha = opacity.clamp(0, 1).toVar();

  material.name = 'RZMPS WebGPU Lit Sprite';
  material.colorNode = spriteColor.rgb.mul(particleColor);
  material.opacityNode = finalAlpha;
  material.alphaTest = 0.001;
  material.envMap = envMap ?? null;
  material.envMapIntensity = envIntensity ?? 1;
  material.roughnessNode = roughnessMap
    ? texture(roughnessMap, spriteUv).r.mul(roughness ?? 0.5)
    : float(roughness ?? 0.5);
  material.metalnessNode = metalnessMap
    ? texture(metalnessMap, spriteUv).r.mul(metalness)
    : float(metalness);

  const transmissionAmount = transmission ?? (transmissionMap ? 1 : 0);

  if (transmissionAmount > 0) {
    const baseTransmission = float(THREE.MathUtils.clamp(transmissionAmount, 0, 1));
    const transmissionValue = transmissionMap
      ? baseTransmission.mul(texture(transmissionMap, spriteUv).r)
      : baseTransmission;

    const transmittedColor = Fn(() => {
      if (!finalDistortionMap || finalDistortionStrength === 0) {
        return viewportSharedTexture().rgb;
      }

      const particleDistortionStrength = spriteData.w;
      const rotation = spriteData.z;
      const distortionNormal = texture(finalDistortionMap, spriteUv).xyz.mul(2).sub(1);
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
        .mul(distortionWorldToUv)
        .toVar();
      const refractedUv = viewportUV.add(distortionUv).toVar();

      return viewportSharedTexture(refractedUv).rgb;
    })();


    const finalTransmisison = float(1.0).sub(finalAlpha.mul(float(1.0).sub(transmissionValue)));

    material.outputNode = vec4(
      mix(output.rgb, transmittedColor, finalTransmisison),
      float(1.0),
    );
  }

  material.userData.frames = frames ?? 1;
  material.userData.normalMap = normalMap;
  material.userData.normalStrength = normalStrength;
  material.userData.roughnessMap = roughnessMap;
  material.userData.metalnessMap = metalnessMap;
  material.userData.normalLighting = normalLighting;
  material.userData.sphericalNormals = sphericalNormalsAmount;
  material.userData.softParticles = softParticles;
  material.userData.softParticleDistance = softParticleDistance;
  material.userData.transmission = transmissionAmount;
  material.userData.transmissionMap = transmissionMap;
  material.userData.distortionMap = finalDistortionMap;
  material.userData.distortionStrength = finalDistortionStrength;

  return material;
};

export default WebGPULitSprite;
