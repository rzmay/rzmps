import SpatialEffect from './SpatialEffect';

export type SpatialEffectConstructor<T extends SpatialEffect = SpatialEffect> = new (...args: never[]) => T;
export type SpatialEffectRequirement = SpatialEffectConstructor | SpatialEffect;

/** Flat effect array with identity-safe, typed constructor views of the same instances. */
export default class SpatialEffectCollection extends Array<SpatialEffect> {
  private readonly groups = new Map<SpatialEffectConstructor, SpatialEffect[]>();

  // Array transforms return ordinary arrays; only the canonical collection owns constructor views.
  static get [Symbol.species](): ArrayConstructor { return Array; }

  /** Reuses a constructor bucket, refreshing it from the canonical flat array after any array mutation. */
  get<T extends SpatialEffect>(constructor: SpatialEffectConstructor<T>): T[] {
    let group = this.groups.get(constructor);
    if (!group) {
      group = [];
      this.groups.set(constructor, group);
    }
    group.length = 0;
    for (const effect of this) if (effect instanceof constructor) group.push(effect);
    return group as T[];
  }

  /** Replace discovery results without changing the collection held by execution contexts. */
  replace(effects: Iterable<SpatialEffect>, requirements: readonly SpatialEffectRequirement[] = []): void {
    const unique = new Set(effects);
    this.length = 0;
    for (const effect of unique) this.push(effect);
    const constructors = requirements.filter((entry): entry is SpatialEffectConstructor => typeof entry === 'function');
    for (const constructor of new Set([...this.groups.keys(), ...constructors])) this.get(constructor);
  }
}
