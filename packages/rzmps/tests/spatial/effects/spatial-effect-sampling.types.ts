import { Module, SpatialEffect, SpatialEffectCollection, BoidAffector, GasAffector,
  GasSimulation } from '../../../build/index.mjs';
import type { ModuleExecutionContext, ModuleGPUExecutionContext } from '../../../build/index.mjs';
const effects = new SpatialEffectCollection();
const boids: BoidAffector[] = effects.get(BoidAffector);
const gas: GasAffector[] = effects.get(GasAffector);
const flat: SpatialEffect[] = effects;
void boids; void gas; void flat;
const module = new Module(() => {}, {
  requireSpatialEffects: [SpatialEffect, GasAffector],
  prepare(context: ModuleExecutionContext) {
    const affectors: GasAffector[] = context.spatialEffects.get(GasAffector);
    void affectors;
  },
  modifyGPU(_particle, _dt, context: ModuleGPUExecutionContext) {
    const affectors: GasAffector[] = context.spatialEffects.get(GasAffector);
    void affectors;
  },
});
module.spatialEffects = [new GasAffector(null, { temperature: 2 })];
const sphere: GasAffector = GasAffector.Sphere({ temperature: [1, 0], densityMultiplier: 0.5 }, 1);
void sphere;
const custom = new GasAffector((cell, dt, _context, strength) => {
  cell.temperature.addAssign(dt.mul(strength));
  cell.velocity.y.addAssign(dt);
  cell.density.mulAssign(0.5);
});
const nativeSphere = GasAffector.Sphere((cell, dt) => cell.temperature.addAssign(dt), {}, 1);
const requirements = new Module(() => {}, { requireSpatialEffects: [GasAffector, custom, nativeSphere] });
const simulation = new GasSimulation({ requireSpatialEffects: [custom, BoidAffector],
  supportSpatialEffects: true, supportForceFields: false });
simulation.supportSpatialEffects = false;
simulation.requireSpatialEffects = [custom];
void requirements;
// @ts-expect-error Gas callbacks belong in the primary argument, never a particle modifyGPU option.
new GasAffector(null, { modifyGPU: () => {} });
// @ts-expect-error Constructor lookup cannot claim an unrelated specialized type.
const wrong: GasAffector[] = effects.get(BoidAffector);
void wrong;
