import { WebGPURenderer } from 'three/webgpu';
/** WebGPU identity alone is insufficient when Three.js fell back to WebGL2. */
export function isWebGPURenderer(renderer: unknown): renderer is WebGPURenderer {
  const candidate = renderer as { isWebGPURenderer?: boolean; backend?: { isWebGLBackend?: boolean } } | undefined;
  return (renderer instanceof WebGPURenderer || candidate?.isWebGPURenderer === true)
    && candidate?.backend?.isWebGLBackend !== true;
}
