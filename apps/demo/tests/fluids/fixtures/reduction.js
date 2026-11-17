import { WebGPURenderer } from 'three/webgpu';
import { uint, vec4 } from 'three/tsl';
import FluidReduction from '../../../../../packages/rzmps/src/simulation/gpu/FluidReduction.ts';
const renderer = new WebGPURenderer();
await renderer.init();
window.reduce = async count => {
  const reduction = new FluidReduction(count);
  reduction.compute(renderer, {}, () => vec4(1, 2, 3, 4), () => uint(1).equal(1));
  const result = [...new Float32Array(await renderer.getArrayBufferAsync(reduction.attribute))];
  const partial = [...new Float32Array(await renderer.getArrayBufferAsync(reduction.partialAttribute))].slice(0, 24);
  const shaders = [...reduction.createdNodes, ...reduction.reduceNodes]
    .map(node => renderer._nodes.getForCompute(node).computeShader);
  reduction.dispose();
  return { result, partial, shaders };
};
window.ready = true;
