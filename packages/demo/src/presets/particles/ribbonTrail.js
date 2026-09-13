import * as THREE from 'three';
import {
  Emitter,
  EmissionShape,
  ParticleSystem,
  TrailRenderer,
  TrailMode,
  TrailTextureMode,
} from '@rzmps/rzmps';
import { curvePresets } from '../curvePresets';

export default async function createRibbonTrail() {
  const ribbonTrail = new ParticleSystem({
    duration: 4,
    looping: true,
    emitters: [
      new Emitter({
        source: EmissionShape.Torus(),
        rate: 50,
        radialSpeed: 5,
        initialValues: {
          lifetime: 1,
          scale: new THREE.Vector3(0.12, 0.12, 0.12),
        },
      }),
    ],
    renderers: [
      new TrailRenderer({
        mode: TrailMode.Ribbon,
        ratio: 1,
        ribbonCount: 3,
        width: 0.15,
        widthOverTrail: (time) => curvePresets.fadeInOut.evaluate(time),
        colorOverTrail: (time) => new THREE.Color().lerpColors(
          new THREE.Color('#fff'),
          new THREE.Color('#66e0ff'),
          time,
        ),
        inheritParticleColor: true,
        materialOptions: {
          roughness: 0,
          metalness: 0,
        },
      }),
    ],
  });

  ribbonTrail.name = 'Ribbon Trail';
  ribbonTrail.position.set(-2, 1, 0);

  return ribbonTrail;
}
