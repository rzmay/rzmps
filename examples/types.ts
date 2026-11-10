import type { Scene, PerspectiveCamera, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/** Minimal discovery data; simulation configuration belongs in the example factory. */
export interface ExampleMetadata {
  id: string;
  title: string;
  description: string;
  tags: string[];
  author: string | { name: string; url?: string };
  previewSettings?: ExamplePreviewSettings;
}

/** Example-specific overrides for the shared documentation capture defaults. */
export interface ExamplePreviewSettings {
  backend?: 'webgl' | 'webgpu';
  format?: 'mp4' | 'webm';
  /** Clip length in seconds; usually matches the root system's duration. */
  duration?: number;
  fps?: number;
  /** Video compression override; lower CRF preserves more detail (shared default: 18). */
  crf?: number;
  frames?: number;
  interval?: number;
  warmup?: number;
  deltaTime?: number;
  /** Poster and video capture dimensions; shared defaults are 1920 × 1080. */
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
