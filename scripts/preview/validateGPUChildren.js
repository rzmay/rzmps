import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, instanceIndex, storage, uvec4 } from 'three/tsl';

/** Explicit preview-only readback audit. Runtime rendering never uses these transfers. */
export async function validateGPUChildren(system, renderer) {
  const results = [];
  const systems = [];
  system.traverse(object => { if (object.isGPUProcessingActive) systems.push(object); });
  for (const owner of systems) for (const view of owner.renderers) {
    const expansion = view._gpuChildren;
    const output = expansion?.output;
    if (!output) continue;
    const capacity = output.capacity;
    const identities = new StorageBufferAttribute(new Uint32Array(capacity * 4), 4);
    const identityNodes = storage(identities, 'uvec4', capacity);
    const audit = Fn(() => {
      const p = output.storage.createParticle();
      identityNodes.element(instanceIndex).assign(uvec4(p.id, p.parent.index, p.root.index));
    })().compute(capacity);
    try {
      renderer.compute(audit);
      const arrays = await Promise.all([
        output.attributes.floatData, output.attributes.uintData, expansion.mapping, expansion.counters, identities,
      ].map(attribute => renderer.getArrayBufferAsync(attribute)));
      const floats = new Float32Array(arrays[0]);
      const states = new Uint32Array(arrays[1]);
      const mapping = new Uint32Array(arrays[2]);
      const counters = new Uint32Array(arrays[3]);
      const ids = new Uint32Array(arrays[4]);
      const originals = owner.gpuParticleBuffers.count;
      const lodStart = originals + counters[0];
      const end = lodStart + counters[1];
      if (counters[2]) throw new Error(`GPU visual arena overflow: ${counters[2]} copies`);
      if (end > capacity) throw new Error('GPU expansion exceeds its arena');
      if (output.indirect) {
        const draw = new Uint32Array(await renderer.getArrayBufferAsync(output.indirect));
        if (draw[1] !== end) throw new Error(`GPU indirect draw range ${draw[1]} differs from expanded range ${end}`);
      }
      let originalAlive = 0, artistic = 0, lod = 0;
      const unique = new Set();
      let maxLODOffset = 0, maxArtisticOffset = 0;
      function parentIndex(index) { return index < originals ? index : mapping[(index - originals) * 2]; }
      function derive(id, index) {
        const ordinal = mapping[(index - originals) * 2 + 1];
        const stage = index < lodStart ? 0x72656e64 : 0x6c6f6421;
        const mixed = (Math.imul(ordinal + 1, 2246822519) ^ stage) >>> 0;
        return [Math.imul(id[0] ^ mixed, 3266489917) >>> 0, Math.imul(id[1] ^ mixed, 668265263) >>> 0];
      }
      for (let index = 0; index < end; index++) {
        if (!states[index * 4]) continue;
        const parent = parentIndex(index), root = parentIndex(parent);
        const offset = Math.hypot(...[0, 1, 2].map(axis => floats[index * output.floatStride + axis] - floats[parent * output.floatStride + axis]));
        if (index >= lodStart) maxLODOffset = Math.max(maxLODOffset, offset);
        else if (index >= originals) maxArtisticOffset = Math.max(maxArtisticOffset, offset);
        if (index < originals) originalAlive++;
        else if (index < lodStart) artistic++;
        else lod++;
        if (index >= originals && (parent >= lodStart || !states[parent * 4])) throw new Error('Invalid immediate parent mapping');
        if (root >= originals || !states[root * 4]) throw new Error('Invalid root mapping');
        let expected = [root, states[root * 4 + 2]];
        if (parent >= originals) expected = derive(expected, parent);
        if (index >= originals) expected = derive(expected, index);
        if (ids[index * 4] !== expected[0] || ids[index * 4 + 1] !== expected[1]) throw new Error('GPU child identity depends on packing');
        if (ids[index * 4 + 2] !== parent || ids[index * 4 + 3] !== root) throw new Error('GPU hierarchy accessor mismatch');
        const identity = `${expected[0]}:${expected[1]}`;
        if (unique.has(identity)) throw new Error('Duplicate GPU particle identity');
        unique.add(identity);
        if (index >= originals) {
          for (let component = 16; component < output.floatStride; component++) {
            if (floats[index * output.floatStride + component]
              !== floats[parent * output.floatStride + component]) {
              throw new Error('Renderer child lost its material appearance or UV patch');
            }
          }
        }
        if (index >= lodStart) {
          for (const component of [3, 8, 9, 10]) {
            if (floats[index * output.floatStride + component] !== floats[parent * output.floatStride + component]) throw new Error('LOD child reapplied artistic modifiers');
          }
        }
      }
      results.push({ system: owner.name, maxLODOffset, maxArtisticOffset, originalAlive, artistic, lod, capacity, overflow: counters[2], hierarchyAndIdentity: 'passed', inheritance: 'passed', indirectRange: 'passed' });
    } finally {
      audit.dispose();
      renderer.backend.destroyAttribute(identities);
    }
  }
  return results;
}
