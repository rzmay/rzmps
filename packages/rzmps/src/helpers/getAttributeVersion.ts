import type { BufferAttribute, InterleavedBufferAttribute } from 'three';

/** Reads the underlying data version; callers choose the sentinel for a missing attribute. */
export default function getAttributeVersion(
  attribute: BufferAttribute | InterleavedBufferAttribute | null | undefined,
  missingVersion = -1,
): number {
  if (!attribute) return missingVersion;
  return 'version' in attribute ? Number(attribute.version) : Number(attribute.data.version ?? 0);
}
