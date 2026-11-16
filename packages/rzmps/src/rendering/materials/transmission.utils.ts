import type { CubeTexture } from 'three';
import type { Node } from 'three/webgpu';
import { float, Fn, If, mix, output, uniform, vec4, viewportTexture, viewportUV } from 'three/tsl';
import LiveCubemap from '../renderers/LiveCubemap';

type CubeCopyBackend = {
  isWebGPUBackend?: boolean;
  _copyFramebufferToTexture?: (...args: unknown[]) => void;
};

export const useSceneDepth = uniform(1).onRenderUpdate(({ camera }) =>
  LiveCubemap.isLiveCubemapCamera(camera ?? undefined) ? 0 : 1,
);

export const useTransmission = uniform(1).onRenderUpdate(({ camera, renderer }) => {
  const backend = renderer?.backend as CubeCopyBackend | undefined;
  return LiveCubemap.isLiveCubemapCamera(camera ?? undefined)
    && backend?.isWebGPUBackend && !backend._copyFramebufferToTexture ? 0 : 1;
});

/** Keep scene-color textures per render target, avoiding resize/upload churn between probe and main views. */
export function sceneColor(uv: Node<'vec2'> = viewportUV): Node<'vec3'> {
  const sample = viewportTexture(uv);
  const update = sample.updateBefore;
  sample.updateBefore = frame => {
    const renderer = frame.renderer;
    const backend = renderer?.backend as CubeCopyBackend | undefined;
    const copy = backend?._copyFramebufferToTexture;
    const targetTexture = renderer?.getRenderTarget()?.texture as CubeTexture | undefined;
    if (!renderer || !targetTexture?.isCubeTexture || !backend?.isWebGPUBackend || !copy)
      return update.call(sample, frame);

    // Three r186 omits the active cube layer in its framebuffer copy. Keep its existing pass/encoder handling,
    // but supply the face only when Three hasn't supplied a layer itself. Restore the method even on failure.
    const face = renderer.getActiveCubeFace();
    backend._copyFramebufferToTexture = (...args) => {
      args[5] ??= face;
      return copy.apply(backend, args);
    };
    try {
      return update.call(sample, frame);
    } finally {
      backend._copyFramebufferToTexture = copy;
    }
  };
  return sample.rgb;
}

/** Fall back to the equivalent alpha contribution when scene-color transmission is unavailable. */
export function transmissionOutput(color: Node<'vec3'>, amount: Node<'float'>, alpha: Node<'float'>): Node<'vec4'> {
  return Fn(() => {
    const result = vec4(output.rgb, output.a.mul(float(1).sub(amount))).toVar();
    If(useTransmission.greaterThan(0), () => {
      const weight = float(1).sub(alpha.mul(float(1).sub(amount)));
      result.assign(vec4(mix(output.rgb, color, weight), 1));
    });
    return result;
  })();
}
