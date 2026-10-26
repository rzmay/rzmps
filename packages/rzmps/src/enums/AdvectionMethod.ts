/** Advection methods for transporting gas fields through the velocity grid. */
enum AdvectionMethod {
  /** First-order semi-Lagrangian advection, the default method. */
  SemiLagrangian = 'SemiLagrangian',
  /** Higher-order MacCormack advection with correction to limit numerical diffusion. */
  MacCormack = 'MacCormack',
}

export { AdvectionMethod };
