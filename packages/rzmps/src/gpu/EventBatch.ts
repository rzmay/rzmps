import { If, Loop, uint } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { GPUEventNodeRecord, GPUEventReader } from './EventBuffer';
import type ParticleSystem from '../ParticleSystem';

/** Shader-side event iteration over a stable range in shared storage. */
export interface GPUEventBatch {
  forEach(name: string, consume: (event: GPUEventNodeRecord) => void): void;
}
/** @internal */
export class SharedGPUEventBatch implements GPUEventBatch {
  constructor(readonly reader: GPUEventReader, readonly origins: readonly ParticleSystem[],
    readonly names: readonly string[] = []) {}

  matches(event: GPUEventNodeRecord, name?: string): Node<'bool'> {
    let eligible = uint(0).equal(uint(1));
    for (const origin of this.origins) {
      const type = name === undefined ? undefined : origin.getGPUEventType(name);
      if (name !== undefined && type === undefined) continue;
      const fromOrigin = event.origin.equal(uint(origin.id));
      eligible = eligible.or(type === undefined ? fromOrigin : fromOrigin.and(event.type.equal(uint(type))));
    }
    return eligible;
  }

  forEach(name: string, consume: (event: GPUEventNodeRecord) => void): void {
    if (!this.names.includes(name)) return;
    // Materialize atomic loads before Loop builds its bounds; otherwise TSL can treat them as void statements.
    const count = this.reader.count().toVar('batchEventCount');
    Loop({ start: 0, end: count, type: 'uint' }, ({ i }) => {
      const event = this.reader.load(i);
      If(this.matches(event, name), () => consume(event));
    });
  }
}
/** @internal */
export const emptyGPUEvents: GPUEventBatch = { forEach() {} };
