import type { VolumeField } from './VolumeField';

/** Supplies simulation-space volume fields independently of their production algorithm. */
export interface VolumeFieldProvider {
  getVolumeField(): VolumeField | undefined;
  getVolumeColorField?(): VolumeField | undefined;
}

