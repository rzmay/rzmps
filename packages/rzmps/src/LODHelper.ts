export interface LODSettings {
  distance: number;
  quality: number;
  maxLevel: number;
  falloff: number;
  continuous: boolean;
}

export type LODSettingsOptions = LODSettings;

export default class LODHelper {
  distance: number;
  quality: number;
  maxLevel: number;
  falloff: number;
  continuous: boolean;
  private _updateCredit = 1;

  constructor(options: Partial<LODSettings> = {}) {
    this.distance = Math.max(options.distance ?? 10, 0);
    this.quality = Math.min(Math.max(options.quality ?? 0.5, 0.01), 1);
    this.maxLevel = Math.max(Math.floor(options.maxLevel ?? 4), 0);
    this.falloff = Math.max(options.falloff ?? 1.5, 1);
    this.continuous = options.continuous ?? false;
  }

  shouldUpdate(distance: number): boolean {
    const result = LODHelper.resolveUpdate(this.getScale(distance), this._updateCredit);
    this._updateCredit = result.nextCredit;

    return result.update;
  }

  reset(): void {
    this._updateCredit = 1;
  }

  private static resolveUpdate(
    multiplier: number,
    previousCredit: number,
  ): { update: boolean; nextCredit: number } {
    if (multiplier >= 1) return { update: true, nextCredit: 0 };

    if (previousCredit >= 1) {
      return {
        update: true,
        nextCredit: previousCredit - 1 + Math.max(multiplier, 0),
      };
    }

    return {
      update: false,
      nextCredit: previousCredit + Math.max(multiplier, 0),
    };
  }

  getScale(distance: number): number {
    if (this.distance <= 0 || this.maxLevel <= 0) return 1;

    if (this.continuous) {
      const level = this.getContinuousLevel(distance);
      return this.quality ** Math.min(Math.max(level, 0), this.maxLevel);
    }

    if (distance < this.distance) return 1;

    const level = Math.floor(this.getContinuousLevel(distance));

    return this.quality ** Math.min(Math.max(level, 0), this.maxLevel);
  }

  private getContinuousLevel(distance: number): number {
    if (distance <= 0) return 0;

    if (this.falloff <= 1) {
      return Math.min(distance / this.distance, this.maxLevel);
    }

    const exponentStep = this.falloff - 1;
    const base = Math.max(this.distance, 1.000001);
    const level = 1 + (Math.log(Math.max(distance, 1)) / Math.log(base) - 1) / exponentStep;

    return Math.min(Math.max(level, 0), this.maxLevel);
  }
}
