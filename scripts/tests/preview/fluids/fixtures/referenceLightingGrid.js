import { LightingGrid } from '@rzmps/rzmps';
import { Fn, Loop, array, float, textureStore, vec4 } from 'three/tsl';
import { directionTransfer } from '../../../../../packages/rzmps/src/rendering/lighting/lightingGrid.utils.ts';

/** Test-only unfactored transfer: the reference samples every coarse bin at every fine probe. */
export class ReferenceLightingGrid extends LightingGrid {
  buildPrograms() {
    super.buildPrograms();
    this.cascades.forEach((level, index) => {
      if (level.referenceMerge === level.merge) return;
      const coarse = this.cascades[index + 1];
      if (!coarse) return;
      const transfer = array(directionTransfer(level.directions, coarse.directions).flat().map(value => float(value)));
      level.merge?.dispose();
      level.merge = Fn(() => {
        const { position, output, bin } = this.address(level);
        const local = level.localRead.load(output), far = vec4(0).toVar();
        const uv = this.probeUV(coarse, position);
        Loop(coarse.directions.length, ({ i }) => {
          const weight = transfer.element(bin.mul(coarse.directions.length).add(i));
          far.addAssign(this.readBin(coarse.mergedRead, coarse, uv, i).mul(weight));
        });
        const radiance = local.xyz.add(local.w.mul(far.xyz));
        textureStore(level.mergedWrite, output, vec4(index === 0 ? radiance.add(this.ambientNode) : radiance,
          local.w.mul(far.w))).toWriteOnly();
      })().compute(level.dimensions.x * level.dimensions.y * level.dimensions.z * level.directions.length);
      level.referenceMerge = level.merge;
    });
  }

  update(renderer, ...args) {
    const compute = renderer.compute;
    renderer.compute = function (node, ...args) {
      if (node.name?.startsWith('rzmps.lighting.angularTransfer')) return;
      return compute.call(this, node, ...args);
    };
    try { return super.update(renderer, ...args); } finally { renderer.compute = compute; }
  }
}
