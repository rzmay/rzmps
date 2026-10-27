export interface LODSettings {
  distance: number;
  quality: number;
  maxLevel: number;
  falloff: number;
  continuous: boolean;
}

export type LODSettingsOptions = LODSettings;

/** Distance-based particle population quality. */
export default class LODHelper {
  distance = 10;
  quality = 0.5;
  maxLevel = 4;
  falloff = 1.5;
  continuous = false;
  constructor(options: Partial<LODSettings> = {}) {
    this.configure(options);
  }

  configure(options: Partial<LODSettings> = {}): void {
    this.distance = Math.max(options.distance ?? 10, 0);
    this.quality = Math.min(Math.max(options.quality ?? 0.5, 0), 1);
    this.maxLevel = Math.max(Math.floor(options.maxLevel ?? 4), 0);
    this.falloff = Math.max(options.falloff ?? 1.5, 1);
    this.continuous = options.continuous ?? false;
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
