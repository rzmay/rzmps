import { SimulationSpace } from '../../build/index.mjs';
import { Matrix4, Object3D, Vector3 } from 'three';
import { vec4 } from 'three/tsl';
import { ParticleSystem, Module, EmissionSource, EmissionShape } from '../../build/index.mjs';
import type { RegisteredEmissionSource, GPUEventPayload } from '../../build/index.mjs';
const parent = new ParticleSystem({ renderers: [] });
const source: RegisteredEmissionSource = parent.registerEmissionSource({ transform: new Matrix4(), tags: ['pool'] });
source.update({ alpha: 0.5, velocity: new Vector3() }).emitEvent('bubble', { strength: 2 });
parent.addSubSystem(new ParticleSystem({ renderers: [] }), {
  tags: ['pool'], onEvent: {
    bubble: (data, origin, context) => {
      // The application narrows its own event schema; the library only carries unknown payloads.
      const strength = typeof data === 'object' && data !== null
        && 'strength' in data && typeof data.strength === 'number' ? data.strength : 1;
      return { scale: context.scale * strength, position: origin.position.clone() };
    },
    gpu: { bubble: (data, particle, context) => ({ scale: context.scale.mul(data[0].x),
      velocity: particle.velocity.mul(data[2].w) }) },
  },
});
new Module(() => {}, { modifyGPU(particle) {
  particle.kill();
  particle.addTag('glowing');
  particle.removeTag('glowing');
  // @ts-expect-error Tags are registered by name, not by numeric bit position.
  particle.addTag(3);
  particle.emitEvent('bubble', vec4(1));
  particle.emitEvent('bubble', [vec4(1), vec4(2), vec4(3)]);
} });
const legacySamplingMode: EmissionSource = EmissionSource.Surface;
new EmissionShape({ source: legacySamplingMode });
// @ts-expect-error CPU event schemas must be narrowed by the application.
const unchecked: import('../../build/index.mjs').CPUEventHandler = data => ({ scale: data.strength });
void unchecked;
// @ts-expect-error Native GPU payloads contain at most three vec4 values.
const tooMany: GPUEventPayload = [vec4(1), vec4(2), vec4(3), vec4(4)];
void tooMany;

new ParticleSystem({ simulationSpace: SimulationSpace.Transform, simulationSpaceTransform: new Object3D() });
new ParticleSystem({ simulationSpace: SimulationSpace.Transform, simulationSpaceTransform: new Matrix4() });
new ParticleSystem({ simulationSpace: SimulationSpace.Source, sourceLossBehavior: SourceLossBehavior.Kill });
// @ts-expect-error Custom frames must be Object3D or world Matrix4 references.
new ParticleSystem({ simulationSpace: SimulationSpace.Transform, simulationSpaceTransform: new Vector3() });

parent.simulationSpace = SimulationSpace.Source;
parent.simulationSpaceTransform = new Object3D();

parent.addSubSystem(new ParticleSystem({ renderers: [] }), { onEvent: {
  rejected: () => false,
  filtered: data => data === 'skip' ? false : { scale: 2 },
  gpu: {
    rejected: () => false,
    filtered: data => data[0].x.greaterThan(0),
  },
} });

// Source-loss policy follows the same enum-or-literal convention as simulation space.
import { SourceLossBehavior } from '../../build/index.mjs';
new ParticleSystem({ sourceLossBehavior: SourceLossBehavior.Kill });
new ParticleSystem({ sourceLossBehavior: SourceLossBehavior.Detach });
// @ts-expect-error The old ambiguous name has been replaced.
new ParticleSystem({ sourceLoss: 'kill' });
// @ts-expect-error Unknown source-loss action.
new ParticleSystem({ sourceLossBehavior: 'freeze' });
