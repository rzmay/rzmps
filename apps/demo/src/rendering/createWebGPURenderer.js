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

export async function createWebGPURenderer(defaultProps) {
  const renderer = new WebGPURenderer(defaultProps);

  RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());

  if (!renderer.library.getLightNodeClass(THREE.AmbientLight)) renderer.library.addLight(AmbientLightNode, THREE.AmbientLight);
  if (!renderer.library.getLightNodeClass(THREE.DirectionalLight)) renderer.library.addLight(DirectionalLightNode, THREE.DirectionalLight);
  if (!renderer.library.getLightNodeClass(THREE.HemisphereLight)) renderer.library.addLight(HemisphereLightNode, THREE.HemisphereLight);
  if (!renderer.library.getLightNodeClass(THREE.PointLight)) renderer.library.addLight(PointLightNode, THREE.PointLight);
  if (!renderer.library.getLightNodeClass(THREE.RectAreaLight)) renderer.library.addLight(RectAreaLightNode, THREE.RectAreaLight);
  if (!renderer.library.getLightNodeClass(THREE.SpotLight)) renderer.library.addLight(SpotLightNode, THREE.SpotLight);

  await renderer.init();

  return renderer;
}

