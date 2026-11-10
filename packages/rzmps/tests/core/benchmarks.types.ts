import { Benchmarks, Module, ParticleSystem, profileRenderer } from '../../build/index';
import type { WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

declare const renderer: WebGPURenderer;
declare const system: ParticleSystem;
declare const webgl: WebGLRenderer;
const b = new Benchmarks();
b.resolveGPU(renderer);
b.resolveGPU(webgl);
profileRenderer(system.benchmarks, webgl, () => webgl.info.render.calls);
system.benchmarks.resolveGPU(renderer);
profileRenderer(system.benchmarks, renderer, () => renderer.info.render.calls);
const value: number = b.span('work', () => 42);
b.derive('ratio', ['used', 'total'], ({ used, total }) => total ? used / total : 0);
b.register('bytes', { type: 'gauge', unit: 'bytes', get: () => value });
b.assert([{ metric: 'bytes', statistic: 'p95', max: 50 }]);
new Module((_p, dt, { module }) => module.benchmarks.set('step', dt));
// @ts-expect-error Unknown aggregation mode.
b.register('invalid', { type: 'span', aggregation: 'average' });
// @ts-expect-error Unknown statistic.
b.assert([{ metric: 'bytes', statistic: 'median' }]);
