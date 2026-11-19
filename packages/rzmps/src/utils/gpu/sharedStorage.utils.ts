import type { StorageBufferAttribute } from 'three/webgpu';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';
import { bindStorageAttributeLifetime } from './storage.utils';

// Leases retain the attribute, not a native GPU handle. Owners still settle compiler/GPU dependencies.
const owners = new WeakMap<StorageBufferAttribute, number>();

export function retainSharedStorage(attribute: StorageBufferAttribute): StorageBufferAttribute {
  owners.set(attribute, (owners.get(attribute) ?? 1) + 1);
  return attribute;
}

/** Release one owner's scratch lease only after its final compiler and queue dependencies finish. */
export function releaseSharedStorage(attribute: StorageBufferAttribute, renderer?: ParticleSpatialGridRenderer): void {
  const count = owners.get(attribute) ?? 1;
  if (count > 1) {
    owners.set(attribute, count - 1);
    return;
  }
  owners.delete(attribute);
  if (renderer) bindStorageAttributeLifetime(renderer, attribute);
  attribute.dispose();
}
