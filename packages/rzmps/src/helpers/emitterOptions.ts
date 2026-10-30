import type { SubSystemOptions } from '../ParticleSystem';
import { eventNames } from '../Events';

/** @internal Omitted override fields retain emitter settings; empty collections are replacements. */
export default function emitterOptions(own: Partial<SubSystemOptions>, overrides: Partial<SubSystemOptions> = {},
  subsystem = false): SubSystemOptions {
  const value = { ...own, ...overrides };
  const eventDriven = value.emitOnSpawn || value.emitOnDeath || value.emitOnCollision
    || eventNames(value.onEvent).length;
  const continuous = value.emitContinuous ?? !eventDriven;
  return { ...value, emitContinuous: continuous, emitOnSpawn: value.emitOnSpawn ?? false,
    emitOnDeath: value.emitOnDeath ?? false, emitOnCollision: value.emitOnCollision ?? false,
    shouldEmit: value.shouldEmit ?? true, ratio: value.ratio ?? 1,
    inheritScale: value.inheritScale ?? (subsystem ? 1 : 0),
    inheritColor: value.inheritColor ?? (subsystem ? 1 : 0),
    inheritAlpha: value.inheritAlpha ?? (subsystem ? 1 : 0),
    inheritLifetime: value.inheritLifetime ?? (subsystem && continuous ? 1 : 0),
    inheritMass: value.inheritMass ?? (subsystem ? 1 : 0), inheritVelocity: value.inheritVelocity ?? 0,
    impulseThreshold: value.impulseThreshold ?? 0, impulseAffectsScale: value.impulseAffectsScale ?? 0,
    impulseAffectsSpeed: value.impulseAffectsSpeed ?? 0, impulseAffectsMass: value.impulseAffectsMass ?? 0,
    impulseAffectsLifetime: value.impulseAffectsLifetime ?? 0,
    impulseAffectsAlignment: value.impulseAffectsAlignment ?? false,
  };
}
