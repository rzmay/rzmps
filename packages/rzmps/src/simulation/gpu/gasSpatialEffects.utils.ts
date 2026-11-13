import type { Node } from 'three/webgpu';
import { If, float, max, uint, vec3 } from 'three/tsl';
import SpatialEffect from '../../spatial/effects/SpatialEffect';
import GasAffector, { type GasCellGPU } from '../../spatial/effects/GasAffector';
import ParticleForceField from '../../spatial/effects/ParticleForceField';
import { createSampleParticleGPU } from '../../spatial/effects/spatialEffectSampling.utils';
import type { GPUParticleUpdateContext } from './Particle';

/** Apply one collected effect to shader-local gas state; the caller owns persistence and projection order. */
export function sampleGasEffectGPU(
  effect: SpatialEffect, cell: GasCellGPU, index: Node<'uint'>, cellSize: Node<'float'>,
  tagMask: number, context: GPUParticleUpdateContext,
): void {
  const state = {
    index, velocity: cell.velocity, color: cell.color, alpha: cell.density,
    mass: cell.density.mul(cellSize.mul(cellSize).mul(cellSize)),
    scale: vec3(cellSize), tagMask: uint(tagMask),
  };
  if (effect instanceof GasAffector) {
    const particle = createSampleParticleGPU(cell.position, state);
    let strength = effect.testGPU(particle, context);
    const mask = context.system.getGPUFilterTagMask(effect.tags);
    if (mask !== undefined) strength = particle.tagMask.bitAnd(uint(mask)).notEqual(0).select(strength, 0);
    If(strength.greaterThan(0), () => effect.applyGasGPU(cell, context.deltaTimeNode, context, strength));
  } else {
    // Preserve reference-air force scaling: a fading tracer concentration must not amplify wind.
    const sampledState = effect instanceof ParticleForceField ? { ...state, mass: float(1) } : state;
    const delta = effect.sampleDeltasGPU(cell.position, sampledState, context.deltaTimeNode, context);
    cell.velocity.addAssign(delta.velocity);
    cell.color.addAssign(delta.color);
    cell.density.assign(max(cell.density.add(delta.alpha), 0));
    If(delta.killed, () => { cell.density.assign(0); });
  }
  cell.color.assign(max(cell.color, vec3(0)));
  If(cell.density.lessThanEqual(float(0)), () => {
    cell.temperature.assign(0);
    cell.color.assign(vec3(0));
  });
}
