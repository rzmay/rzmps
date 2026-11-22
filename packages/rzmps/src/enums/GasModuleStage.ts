/** Callback stage used when discovering gas modules and tracking their GPU graph dependencies. @internal */
export enum GasModuleStage {
  /** Persistent per-cell modifications evaluated by the gas simulation. */
  Simulation = 'Simulation',
  /** Transient visual modifications evaluated at volume-rendering samples. */
  Render = 'Render',
}
