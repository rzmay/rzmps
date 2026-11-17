import { profileFluidStages } from './fluidProfiling.utils.js';

/** Exclusive dispatch labels, shared by normal gas benchmarks and lifecycle diagnostics. */
export function gasStage(node, fallback = 'activation/other') {
  const name = node.name ?? '';
  if (name.startsWith('rzmps.lighting.injection')) return 'lighting/injection';
  if (name.startsWith('rzmps.lighting.angularTransfer')) return 'lighting/angular-transfer';
  if (name.startsWith('rzmps.lighting.merge')) return 'lighting/propagation';
  if (name.startsWith('rzmps.lighting')) return 'lighting/isotropic-scattering';
  if (name.includes('rendererOccupancy')) return 'volume/occupancy';
  if (name.includes('occupiedSupport') || name.includes('remapSupport')) return 'activation/occupied-support';
  if (name.includes('receiverBrickRing')) return 'activation/guard-support';
  if (name.includes('sourceRequests') || name.includes('countRequests') || name.includes('requestReset'))
    return 'activation/requests';
  if (name.includes('activeList')) return 'activation/compaction';
  if (name.includes('.admit.') || name.includes('admissionBudgets') || name.includes('.release'))
    return 'activation/admission';
  if (name.startsWith('rzmps.domain') || name.includes('directorySnapshot')) return 'activation/directory';
  if (name.includes('sourceMask')) return 'activation/source-mask';
  if (name.startsWith('rzmps.guard.')) return 'activation/guard-support';
  if (name.startsWith('rzmps.gas.supportReduction')) return 'activation/occupied-support-reduction';
  return fallback;
}

/** Use the shared fluid timer with gas-specific dispatch labels. */
export function profileGasStages(renderer, gas, volume, state) {
  return profileFluidStages(renderer, [[gas, 'gas'], [volume?.lightingGrid, 'lighting']], state, gasStage);
}
