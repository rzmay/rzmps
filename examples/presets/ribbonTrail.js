import { Curve } from 'curves';
import * as THREE from 'three';
import { Emitter, EmissionShape, ParticleSystem, TrailRenderer, TrailMode } from '@rzmps/rzmps';

export default async function ribbonTrailPreset() {
  // #region docs:system:1

  // #region docs:modules:none

  // #region docs:emitters:1
  const ribbonTrailEmitters = [
    new Emitter({
      source: EmissionShape.Torus(),
      rate: 50,
      radialSpeed: 5,
      initialValues: {
        lifetime: 1,
        scale: 0.12,
      },
    }),
  ];
  // #endregion docs:emitters:1

  // #region docs:renderers:1
  const ribbonTrailRenderers = [
    new TrailRenderer({
      mode: TrailMode.Ribbon,
      ratio: 1,
      ribbonCount: 3,
      width: 0.15,
      widthOverTrail: new Curve({ 0: 0, 0.2: 1, 1: 0 }),
      colorOverTrail: time => new THREE.Color().lerpColors(new THREE.Color('#fff'), new THREE.Color('#66e0ff'), time),
      inheritParticleColor: true,
      materialOptions: {
        roughness: 0,
        metalness: 0,
      },
    }),
  ];
  // #endregion docs:renderers:1

  // #region docs:system:assembly
  const ribbonTrail = new ParticleSystem({
    maxParticles: 128,
    duration: 4,
    looping: true,

    emitters: ribbonTrailEmitters,

    renderers: ribbonTrailRenderers,
  });
  // #endregion docs:system:assembly
  // #endregion docs:modules:none
  // #endregion docs:system:1

  ribbonTrail.name = 'Ribbon Trail';
  ribbonTrail.position.set(0, 0, 0);

  return ribbonTrail;
}

/** @type {import("../types").ExampleMetadata} */
ribbonTrailPreset.metadata = {
  author: 'rzmay',
  id: 'ribbonTrail',
  title: 'Ribbon Trail',
  description: 'Ribbon trail rendering for continuous streaks with lifetime fading.',
  tags: ['ribbonTrail', 'trails', 'ribbon', 'effects'],
  previewSettings: {
    duration: 4,
  },
};
