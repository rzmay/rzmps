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

/** Split dispatch arrays only while profiling, so differently labelled programs get separate timestamp scopes. */
export function profileGasStages(renderer, gas, volume, state) {
  const compute = renderer.compute, restorations = [];
  renderer.compute = function (nodes, ...args) {
    const previous = state.stage;
    try {
      for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
        state.stage = gasStage(node, previous ?? 'activation/other');
        compute.call(this, node, ...args);
      }
    } finally { state.stage = previous; }
  };
  for (const [owner, prefix] of [[gas, 'gas'], [volume?.lightingGrid, 'lighting']]) {
    if (!owner) continue;
    const span = owner.benchmarks.span;
    owner.benchmarks.span = function (name, callback) {
      const previous = state.stage;
      state.stage = `${prefix}/${name}`;
      const start = performance.now();
      try { return span.call(this, name, callback); } finally {
        state.cpuStages ??= {};
        const key = `${prefix}/${name}`;
        state.cpuStages[key] = (state.cpuStages[key] ?? 0) + performance.now() - start;
        state.stage = previous;
      }
    };
    restorations.push(() => { owner.benchmarks.span = span; });
  }
  return () => { renderer.compute = compute; restorations.forEach(restore => restore()); };
}
