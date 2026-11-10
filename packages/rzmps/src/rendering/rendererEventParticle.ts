import Particle from '../core/Particle';
import type ParticleSystem from '../core/ParticleSystem';
import type { SimulationEvent } from '../events/EventReceiver';

/** A renderer-local view; the original event source stays unchanged and available to the handler. */
export default function rendererEventParticle(event: SimulationEvent, system: ParticleSystem): Particle {
  const source = event.source;
  // Immediate local delivery already has the correct frame and preserves sampler/source identity.
  if (source instanceof Particle && event.origin === system) return source;
  const particle = source instanceof Particle ? source.clone() : new Particle(source ? {
    position: source.position.clone(), rotation: source.rotation.clone(), scale: source.scale.clone(),
    velocity: source.velocity.clone(), color: source.color.clone(), alpha: source.alpha,
    mass: source.mass, lifetime: source.lifetime, tags: source.tags?.slice(),
  } : {});
  particle.id = source?.id ?? `system:${event.origin.uuid}`;
  particle.realtime = source?.realtime ?? 0;
  particle.time = source?.time ?? 0;
  particle.alive = source?.alive ?? true;
  if (event.origin !== system) {
    const frame = system.getSimulationToWorldMatrix().invert().multiply(event.origin.getSimulationToWorldMatrix());
    particle.transformSimulationFrame(frame);
  }
  return particle;
}
