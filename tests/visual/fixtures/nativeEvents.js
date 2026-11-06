import * as THREE from 'three';
import { If, vec4 } from 'three/tsl';
import { ColorOverLifetime, Emitter, EmissionShape, Module, ParticleSystem, SpriteRenderer, Textures }
  from '@rzmps/rzmps';

export default async function createNativeEvents() {
  // #region docs:system:1
  // #region docs:modules:1
  const vent = new Module((particle, dt) => {
    if (particle.realtime >= 600 && particle.realtime < 600 + dt * 1000) {
      particle.emitEvent('vent', { strength: 1.5, velocity: new THREE.Vector3(0, 1, 0),
        color: new THREE.Color('#96ff45') });
    }
  }, { modifyGPU(particle, dt) {
    particle.removeTag('venting');
    If(particle.realtime.greaterThanEqual(600).and(particle.realtime.lessThan(dt.mul(1000).add(600))), () => {
      particle.addTag('venting');
      particle.emitEvent('vent', [
        vec4(1.5, 0.3, 120, 0),     // strength, radius, temperature, reserved
        vec4(0, 1, 0, 0),          // additional velocity
        vec4(0.3, 1, 0.05, 0.8),   // color and alpha multiplier
      ]);
    });
  } });
  // #endregion docs:modules:1
  const system = new ParticleSystem({ gravityModifier: 0, maxParticles: 128,
    // #region docs:emitters:1
    emitters: new Emitter({ source: EmissionShape.Sphere(0.3), rate: 3, radialSpeed: 0.3,
      initialValues: { position: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3(0, 1.5, 0),
        scale: 0.16, lifetime: 1.5, color: '#81dd31' } }),
    // #endregion docs:emitters:1
    modules: [vent],
    // #region docs:renderers:1
    renderers: new SpriteRenderer(Textures.Circle, { tags: ['venting'] }),
    // #endregion docs:renderers:1
  });
  const burst = new ParticleSystem({ duration: 0.25, gravityModifier: 0.25, maxParticles: 512,
    emitters: new Emitter({ source: EmissionShape.Sphere(0.12), bursts: [{ time: 0, count: 12 }, { time: 0.5,
      count: 4 }],
      radialSpeed: 1.2, initialValues: { scale: 0.07, lifetime: 1.1, alpha: 0.9 } }),
    modules: [new ColorOverLifetime({ alpha: t => 1 - t })],
    renderers: new SpriteRenderer(Textures.Circle),
  });
  system.name = 'Native Event Origins';
  burst.name = 'GPU Payload Splashes';
  system.addSubSystem(burst, { inheritScale: 0, inheritColor: 0, inheritLifetime: 0,
    onEvent: {
      vent: (data, particle, context) => {
        if (typeof data !== 'object' || data === null || !('strength' in data)
          || typeof data.strength !== 'number' || !('velocity' in data)
          || !(data.velocity instanceof THREE.Vector3) || !('color' in data)
          || !(data.color instanceof THREE.Color)) return;
        return {
          scale: data.strength,
          velocity: data.velocity,
          color: data.color,
          alpha: context.alpha * 0.8,
        };
      },
      gpu: { vent: (data, particle, context) => ({
        scale: context.scale.mul(data[0].x),
        velocity: context.velocity.add(data[1].xyz),
        color: data[2].xyz,
        alpha: context.alpha.mul(data[2].w),
      }) },
    },
  });
  // A third level verifies that event-born GPU particles remain subsystem sources.
  const flecks = new ParticleSystem({ duration: 0.12, gravityModifier: 0.1, maxParticles: 128,
    emitters: new Emitter({ source: EmissionShape.Sphere(0.03), bursts: { time: 0, count: 1 },
      radialSpeed: 0.4, initialValues: { scale: 0.025, lifetime: 0.4, color: '#dcff82' } }),
    modules: [new ColorOverLifetime({ alpha: t => 1 - t })],
    renderers: new SpriteRenderer(Textures.Circle),
  });
  flecks.name = 'Nested Splash Flecks';
  burst.addSubSystem(flecks, { emitOnDeath: true, inheritScale: 0, inheritColor: 0, inheritLifetime: 0 });
  // #endregion docs:system:1
  return system;
}
createNativeEvents.author = 'rzmay';
export const metadata = {
  id: 'nativeEvents', title: 'Native Custom Events',
  description: 'Native GPU vent events use three vec4 payloads to drive nested splashes without event readback.',
  tags: ['gpu', 'events', 'payload', 'acid'], category: 'effects',
};
createNativeEvents.description = metadata.description;
