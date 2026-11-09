import type { Scene, PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/** Minimal discovery data; simulation configuration belongs in the example factory. */
export interface ExampleMetadata {
  id: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  author: string | { name: string; url?: string };
  previewSettings?: ExamplePreviewSettings;
}

/** Example-specific overrides for the shared documentation capture defaults. */
export interface ExamplePreviewSettings {
  backend?: 'webgl' | 'webgpu';
  frames?: number;
  interval?: number;
  warmup?: number;
  deltaTime?: number;
  width?: number;
  height?: number;
  seed?: number;
  cameraPosition?: [number, number, number];
  cameraTarget?: [number, number, number];
  cameraFov?: number;
  sceneLightStrength?: number;
  /** Import a scene factory directly; omit for the neutral preview environment. */
  scene?: ((scene: Scene, renderer: WebGLRenderer | WebGPURenderer, camera: PerspectiveCamera) => unknown) | null;
}
