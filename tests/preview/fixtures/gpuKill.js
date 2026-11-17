import { If } from 'three/tsl';
import { Emitter, EmissionShape, Module, ParticleSystem, SpriteRenderer, Textures } from '@rzmps/rzmps';

export default function createGPUKill() {
  const killAfter = (age, options = {}) => new Module(particle => {
    if (particle.realtime >= age) particle.kill();
  }, {
    ...options,
    modifyGPU(particle) {
      If(particle.realtime.greaterThanEqual(age), () => {
        particle.kill();
      });
    },
  });
  const root = new ParticleSystem({
    gravityModifier: 0,
    maxParticles: 8,
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.1),
      bursts: { time: 0, count: 2 },
      tags: ['stored', 'fused'],
      tagSelection: 'distribute',
      initialValues: { lifetime: 10, scale: 0.1 },
    }),
    modules: [
      killAfter(200, { tags: 'stored', useSpatialGrid: true }),
      killAfter(400, { tags: 'fused' }),
    ],
    renderers: new SpriteRenderer(Textures.Circle),
  });
  root.name = 'Kill Origins';
  const markers = new ParticleSystem({
    duration: 0.1,
    gravityModifier: 0,
    maxParticles: 8,
    emitters: new Emitter({
      source: EmissionShape.Sphere(0.1),
      bursts: { time: 0, count: 1 },
      initialValues: { lifetime: 5, scale: 0.2 },
    }),
    renderers: new SpriteRenderer(Textures.Circle),
  });
  markers.name = 'Kill Death Markers';
  root.addSubSystem(markers, { emitOnDeath: true, inheritLifetime: 0 });
  return root;
}
