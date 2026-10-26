/** Particle and field behavior at the finite size cap of a fluid simulation. */
enum FluidBoundsPolicy {
  /** Keep escaped particles alive under ordinary particle motion, without fluid-grid coupling. */
  Ballistic = 'Ballistic',
  /** Kill particles whose centers leave the cap; previously emitted gas remains in the field. */
  Kill = 'Kill',
  /** Confine particle radii and close fluid flux at the cap, preserving tangential motion. */
  Contain = 'Contain',
}

export { FluidBoundsPolicy };
