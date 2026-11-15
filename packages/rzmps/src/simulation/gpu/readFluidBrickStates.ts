import { Vector3, type Texture } from 'three';
import { StorageBufferAttribute } from 'three/webgpu';
import { Fn, If, Loop, float, instanceIndex, ivec3, max, storage, texture3D, uint, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type SparseVolumeGrid from '../../spatial/structures/gpu/SparseVolumeGrid';
import type { ParticleSpatialGridRenderer } from '../../spatial/structures/ParticleSpatialGrid';

type Field = { element(index: Node | number): Node<'vec4'> };

/** Explicit debug probe only: no field download or probe dispatch is added to ordinary frames. */
export async function readFluidBrickStates(renderer: ParticleSpatialGridRenderer, grid: SparseVolumeGrid,
  density: Field, exported: Texture, backing: Vector3, centers: readonly Vector3[],
  occupancy?: { texture: Texture; resolution: Vector3 },
  window?: { offset: Vector3; resolution: Vector3 }) {
  if (centers.length === 0) return [];
  const positions = new StorageBufferAttribute(new Float32Array(centers.flatMap(p => [p.x, p.y, p.z, 0])), 4);
  const results = new StorageBufferAttribute(new Float32Array(centers.length * 16), 4);
  const input = storage(positions, 'vec4', centers.length), output = storage(results, 'vec4', centers.length * 4);
  const texture = texture3D(exported), mask = occupancy ? texture3D(occupancy.texture) : undefined;
  const node = Fn(() => {
    const brick = ivec3(input.element(instanceIndex).xyz.sub(vec3(grid.bounds.min)).div(grid.brickSize).floor());
    const inside = vec3(brick).greaterThanEqual(0).all()
      .and(vec3(brick).lessThan(grid.getBrickDimensionsNode()).all());
    const record = instanceIndex.mul(4);
    for (let row = 0; row < 4; row++) output.element(record.add(row)).assign(vec4(0));
    If(inside, () => {
      const encoded = grid.pages.element(grid.flatten(brick, grid.brickDimensions)).toVar();
      const slot = encoded.greaterThan(0).select(encoded, uint(1)).sub(1);
      const physical = float(0).toVar(), exportedDensity = float(0).toVar(), occupied = float(0).toVar();
      If(encoded.greaterThan(0), () => {
        Loop(grid.cellsPerBrick, ({ i }) => {
          const cell = brick.mul(grid.brickSide).add(grid.unpack(uint(i), grid.brickSide));
          physical.assign(max(physical, density.element(slot.mul(grid.cellsPerBrick).add(uint(i))).x));
          const texel = window ? vec3(cell).sub(vec3(window.offset)) : vec3(cell);
          If(texel.greaterThanEqual(0).all().and(texel.lessThan(vec3(window?.resolution ?? backing)).all()), () => {
            exportedDensity.assign(max(exportedDensity,
              texture.sample(texel.add(0.5).div(vec3(backing))).level(float(0)).r));
            if (mask && occupancy) occupied.assign(max(occupied, mask.sample(
              texel.div(8).floor().add(0.5).div(vec3(occupancy.resolution)),
            ).level(float(0)).r));
          });
        });
      });
      output.element(record).assign(vec4(1, grid.requestPriority(brick), encoded,
        encoded.greaterThan(0).and(grid.isNew(slot.mul(grid.cellsPerBrick))).select(1, 0)));
      output.element(record.add(1)).assign(vec4(encoded.greaterThan(0).and(grid.slotIsActive(slot)).select(1, 0),
        physical, exportedDensity, occupied));
      output.element(record.add(2)).assign(vec4(grid.requestFirstFrame(brick), 0, 0, 0));
      output.element(record.add(3)).assign(vec4(0, grid.frameNumber, 0, 0));
      If(encoded.greaterThan(0), () => {
        output.element(record.add(2)).assign(vec4(grid.slotTimeline(slot, 0), grid.slotTimeline(slot, 1),
          grid.slotTimeline(slot, 2), grid.slotTimeline(slot, 3)));
        output.element(record.add(3)).assign(vec4(grid.slotTimeline(slot, 4), grid.frameNumber, 0, 0));
      });
    });
  })().compute(centers.length).setName('rzmps.volume.debugBrickChain');
  try {
    renderer.compute(node);
    const values = new Float32Array(await renderer.getArrayBufferAsync(results));
    return centers.map((position, index) => {
      const r = values.subarray(index * 16, index * 16 + 16);
      return { position: position.toArray(), frameKind: 'simulation-step' as const,
        logical: !!r[0], priority: r[1], resident: !!r[2], slot: r[2] - 1,
        fresh: !!r[3], active: !!r[4], maximumPhysicalDensity: r[5], maximumExportDensity: r[6],
        rendererOccupied: occupancy ? r[7] > 0 : null,
        firstRequestFrame: r[8], admissionFrame: r[9], firstSimulationWriteFrame: r[10],
        firstExportFrame: r[11], firstRenderSubmissionFrame: r[12], observedFrame: r[13],
        firstVisibleFrame: null }; // Camera visibility requires the caller's frozen-frame pixel observation.
    });
  } finally { node.dispose(); positions.dispose(); results.dispose(); }
}
