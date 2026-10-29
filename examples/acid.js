import * as THREE from 'three';
import {
  ColorOverLifetime,
  DecalRenderer,
  DistortionBySize,
  Emitter,
  EmissionShape,
  Module,
  ParticleSystem,
  RotationOverLifetime,
  ScaleOverLifetime,
  SpriteRenderer,
  Textures,
  TransformByNoise,
} from '@rzmps/rzmps';
import createSplatter from './splatter.js';
import smokeAlpha from '../apps/demo/src/assets/images/smoke_alpha.jpg?url';
import simpleNorm from '../apps/demo/src/assets/images/simple_norm.png?url';

export default async function createAcid() {
  const textureLoader = new THREE.TextureLoader();
  const transmissionMap = textureLoader.load(Textures.Simple);
  const distortionMap = textureLoader.load(simpleNorm);

  // #region docs:system:1
  // Reuse Splatter's collision scene conventions and owned texture/material lifecycle.
  const acid = await createSplatter();
  acid.name = 'Acid';
  acid.prewarm = true;
  acid.emitters[0].rate = 0.3;
  acid.emitters[0].initialValues.color = new THREE.Color('#7ee927');
  const decals = acid.renderers.find(renderer => renderer instanceof DecalRenderer);
  decals.emissionTags = ['acid-pool'];
  decals.lifetime = 18;
  decals.maxDecals = 64;
  decals.opacity = t => 1 - THREE.MathUtils.smoothstep(t, 0.55, 1);
  decals.size = 15;

  // #region docs:emitters:1
  // Shape points become offsets within each pool's emission frame, including its scale.
  const smokeShape = EmissionShape.Sphere(0.2);
  smokeShape.scale.set(1, 0.12, 1);
  const smoke = new ParticleSystem({
    duration: 60,
    gravityModifier: -0.005,
    maxParticles: 4096,
    emitters: new Emitter({
      source: smokeShape,
      rate: 5,
      radialSpeed: 0.08,
      initialValues: {
        lifetime: [2, 3.5],
        scale: 1.5,
        alpha: 0.025,
        color: '#83cf3e',
        velocity: new THREE.Vector3(0, 0.55, 0),
      },
    }),
    modules: [
      new TransformByNoise({ strength: 0.25, frequency: 0.7 }),
      new RotationOverLifetime({
        angularVelocity: [-0.5, 0.5],
      }),
      new ScaleOverLifetime({ scale: t => 0.35 + (1.8 - 0.35) * t }),
      new ColorOverLifetime({ alpha: t => Math.sin(t * Math.PI) }),
    ],
    renderers: new SpriteRenderer(Textures.Default, {
      alphaMap: smokeAlpha,
      softParticleDistance: 0.4,
    }),
  });
  const bubbleShape = EmissionShape.Sphere(0.35);
  bubbleShape.scale.set(1, 0.12, 1);
  bubbleShape.position.y = 0.1;
  const bubbles = new ParticleSystem({
    duration: 0.35,
    gravityModifier: -0.005,
    maxParticles: 2048,
    useLiveCubemap: true,
    emitters: new Emitter({
      source: bubbleShape,
      bursts: { time: 0, count: 6 },
      radialSpeed: 0.12,
      initialValues: {
        lifetime: [4, 7],
        scale: [0.12, 0.26],
        mass: 0.25,
        color: ['#ccffd0', '#e0ffb8', '#bfffe4'],
        velocity: new THREE.Vector3(0, 0.35, 0),
      },
    }),
    modules: [
      new TransformByNoise({
        strength: new THREE.Vector3(0.2, 0.05, 0.2),
        frequency: 0.6,
      }),
      new ScaleOverLifetime({
        scale: t => Math.pow(THREE.MathUtils.clamp(t * 5, 0, 1), 3),
      }),
      new DistortionBySize({ sizeRange: [0, 1], distortionStrength: [0, 1] }),
      new ColorOverLifetime({ alpha: t => 1 - THREE.MathUtils.smoothstep(t, 0.75, 1) }),
    ],
    renderers: new SpriteRenderer(Textures.Circle, {
      material: 'lit',
      materialOptions: {
        roughness: 0.15,
        metalness: 0.5,
        sphericalNormals: 1,
        normalLighting: 0.75,
        transmissionMap,
        transmission: 0.7,
        distortionMap,
        distortionStrength: -0.05,
      },
    }),
  });
  // #endregion docs:emitters:1

  // #region docs:modules:1
  class PoolBubbling extends Module {
    constructor() {
      super(() => {}, { modifyGPU() {} });
      this.remaining = new Map();
    }

    // A once-per-step hook for this factory's scheduler; modify/modifyGPU remain empty.
    prepare(system, dt) {
      super.prepare(system, dt);
      const alive = new Set();
      for (const decal of decals.decals) {
        const source = decal.source;
        if (!source) continue;
        alive.add(source.id);
        const remaining = (this.remaining.get(source.id) ?? (2 + Math.random() * 2)) - dt;
        if (remaining <= 0) {
          source.emitEvent('bubble', { strength: 0.5 + Math.random() });
          this.remaining.set(source.id, 7 + Math.random() * 4);
        } else this.remaining.set(source.id, remaining);
      }
      for (const id of this.remaining.keys()) if (!alive.has(id)) this.remaining.delete(id);
    }
  }
  acid.addModule(new PoolBubbling());
  // #endregion docs:modules:1

  // #region docs:renderers:1
  smoke.name = 'Pool Smoke';
  bubbles.name = 'Pool Bubbles';
  acid.addSubSystem(smoke, {
    tags: ['acid-pool'],
    emitContinuous: true,
    inheritLifetime: 0,
    inheritColor: 0,
    inheritScale: 1,
    inheritAlpha: 1,
  });
  acid.addSubSystem(bubbles, {
    tags: ['acid-pool'],
    inheritLifetime: 0,
    inheritColor: 0,
    onEvent: {
      bubble: (data, source, context) => {
        const strength = typeof data === 'object' && data !== null
          && 'strength' in data && typeof data.strength === 'number' ? data.strength : 1;
        return {
          scale: strength,
          velocity: new THREE.Vector3(0, strength * 0.12, 0),
          alpha: context.alpha,
        };
      },
    },
  });
  // #endregion docs:renderers:1
  // #endregion docs:system:1
  acid.addEventListener('destroyed', () => {
    transmissionMap.dispose();
    distortionMap.dispose();
  });
  return acid;
}
createAcid.author = 'rzmay';
export const metadata = {
  id: 'acid',
  title: 'Acid',
  description: 'Green acid pools emit rotating smoke and floating refractive bubbles. Select Checkerboard for a floor.',
  tags: ['acid', 'decals', 'sources', 'events', 'smoke'],
  category: 'effects',
};
createAcid.description = metadata.description;
