/** Preview-only audit of the canonical firefly configuration on CPU and native GPU simulation. */
export async function validateFireflyAttachments(system) {
  const glow = [...system.subSystems.keys()].find(child => child.name === 'Firefly Pulses');
  if (!glow) throw new Error('Firefly pulse subsystem is missing');
  const read = async owner => owner.isGPUProcessingActive
    ? (await owner.selectiveReadback(Infinity, ['position', 'velocity'])).filter(result => result.valid)
      .map(result => result.particle)
    : owner.particles.filter(particle => particle.alive);
  const sources = await read(system);
  const pulses = await read(glow);
  const positions = sources.map(particle => system.simulationToWorld(particle.position.clone()));
  let maxDistance = 0;
  for (const particle of pulses) {
    const position = glow.simulationToWorld(particle.position.clone());
    const distance = Math.min(...positions.map(source => source.distanceTo(position)));
    maxDistance = Math.max(maxDistance, distance);
    // The 0.01 box permits a fixed offset of at most sqrt(3) * 0.005 from the source center.
    if (distance > 0.01 || particle.velocity.length() > 1e-6) {
      throw new Error(`Firefly pulse drifted from its source: distance ${distance}, `
        + `speed ${particle.velocity.length()}`);
    }
  }
  return { pulses: pulses.length, maxDistance };
}
