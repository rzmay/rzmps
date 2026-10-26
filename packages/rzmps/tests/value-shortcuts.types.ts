import { Color, Vector3 } from 'three';
import { vec3 } from 'three/tsl';
import { Emitter, ColorBySpeed, ScaleByDepth, TransformByNoise, DecalRenderer } from '../build/index.mjs';
import { MeshBasicMaterial } from 'three';

new Emitter({
  initialValues: {
    color: () => new Set(['red', 0xff0000, new Color('blue')]),
    scale: () => [1, new Vector3(2, 3, 4)],
    scalarVelocity: 2,
    scalarAcceleration: vec3(1),
    position: new Vector3(1, 2, 3),
  },
});
new ColorBySpeed({ color: ['red', () => 0x0000ff] });
new ScaleByDepth({ scale: [1, () => 2], scalarVelocity: 0, scalarAcceleration: 0 });
new TransformByNoise({ strength: 2 });
const decals = new DecalRenderer(new MeshBasicMaterial(), {
  color: () => new Set(['red', 0xffffff, new Color('blue')]),
  size: [1, () => new Vector3(2, 3, 1)],
});
decals.color = '#ff8800';
decals.size = new Vector3(2, 1, 1);
new DecalRenderer(new MeshBasicMaterial(), {
  // @ts-expect-error Directional inputs require explicit vectors.
  direction: 1,
});
new Emitter({ initialValues: {
  // @ts-expect-error Positions require explicit vectors.
  position: 1,
} });
new Emitter({ initialValues: {
  // @ts-expect-error Directional inputs require explicit vectors.
  velocity: 1,
} });
