import { StorageBufferAttribute } from 'three/webgpu';
import {
  Fn, If, atomicLoad, atomicMax, atomicMin, atomicStore, bitcast, float, ivec3, storage, uint, vec3,
} from 'three/tsl';

// Diagnostic only: capture fine pressure phases, then sample each at the final worst MAC-divergence cell.
export function createPressureProbe(gas, projection, renderer) {
  const grid = gas.volumeGrid, attributes = [], nodes = [];
  const scalar = (length, atomic = false) => {
    const attribute = new StorageBufferAttribute(atomic ? new Uint32Array(length) : new Float32Array(length), 1);
    attributes.push(attribute);
    const node = storage(attribute, atomic ? 'uint' : 'float', length);
    return atomic ? node.toAtomic() : node;
  };
  const peak = scalar(2, true), output = scalar(96);
  const phases = ['initial', 'preSmoothing', 'prolongation', 'postSmoothing', 'completion'];
  const snapshots = phases.map(() => scalar(grid.cellCount));
  const copies = snapshots.map(target => grid.compute(index => target.element(index)
    .assign(gas.pressureCurrent.element(index))));
  nodes.push(...copies);
  const trace = (phase, level) => {
    const index = phases.indexOf(phase);
    if (!level && index >= 0) renderer.compute(copies[index]);
  };
  const reset = Fn(() => {
    atomicStore(peak.element(0), uint(0)); atomicStore(peak.element(1), uint(0xffffffff));
  })().compute(1);
  const reduce = grid.compute(index => {
    const c = grid.coordinate(index).toVar();
    If(projection.active(c), () => atomicMax(peak.element(0), bitcast(projection.divergenceAt(c).abs(), 'uint')));
  });
  const locate = grid.compute(index => {
    const c = grid.coordinate(index).toVar();
    If(projection.active(c).and(bitcast(projection.divergenceAt(c).abs(), 'uint').equal(atomicLoad(peak.element(0)))),
      () => atomicMin(peak.element(1), index));
  });
  const gather = Fn(() => {
    const index = atomicLoad(peak.element(1)).toVar(), c = grid.coordinate(index).toVar();
    output.element(0).assign(float(index));
    for (const [i, axis] of ['x', 'y', 'z'].entries()) output.element(1 + i).assign(float(c[axis]));
    output.element(4).assign(bitcast(atomicLoad(peak.element(0)), 'float'));
    output.element(5).assign(grid.isNew(index).select(1, 0));
    output.element(6).assign(gas.pressureCurrent.element(index));
    output.element(7).assign(gas.divergence.element(index));
    output.element(8).assign(gas.faceOpenness.element(index).w);
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const entry = axis * 2 + Number(sign > 0), neighbor = c.add(projection.axis(axis).mul(sign));
      output.element(10 + entry).assign(projection.stencilWeights.element(index.mul(6).add(entry)));
      output.element(16 + entry).assign(gas.pressureCurrent.element(
        projection.stencilIndices.element(index.mul(7).add(entry))));
      output.element(22 + entry).assign(grid.index(neighbor).equal(grid.getCellCountNode().sub(1)).select(1, 0));
      output.element(28 + entry).assign(projection.open(sign < 0 ? c : neighbor, axis));
      output.element(34 + entry).assign(projection.inside(neighbor).not().select(1, 0));
    }
    for (const [i, axis] of ['x', 'y', 'z'].entries()) {
      output.element(40 + i).assign(float(c[axis].mod(grid.brickSide)));
    }
  })().compute(1);
  const coarse = Fn(() => {
    const level = projection.multigrid.levels[0];
    const c = grid.coordinate(atomicLoad(peak.element(1))).toVar();
    const index = level.grid.index(ivec3(vec3(c).div(level.ratio)));
    for (const [i, axis] of ['x', 'y', 'z', 'w'].entries()) {
      output.element(44 + i).assign(level.values.element(index)[axis]);
      output.element(48 + i).assign(level.coefficients.element(index)[axis]);
    }
  })().compute(1);
  const stageSamples = snapshots.map((pressure, i) => Fn(() => {
    const index = atomicLoad(peak.element(1)).toVar();
    const sum = float(0).toVar(), diagonal = float(0).toVar();
    for (let entry = 0; entry < 6; entry++) {
      const weight = projection.stencilWeights.element(index.mul(6).add(entry));
      sum.addAssign(pressure.element(projection.stencilIndices.element(index.mul(7).add(entry))).mul(weight));
      diagonal.addAssign(weight);
    }
    const p = pressure.element(index);
    output.element(64 + i * 4).assign(p);
    output.element(65 + i * 4).assign(gas.divergence.element(index)
      .sub(sum.sub(diagonal.mul(p)).div(gas.cellSizeNode.pow(2))));
    output.element(66 + i * 4).assign(diagonal);
  })().compute(1));
  nodes.push(reset, reduce, locate, gather, coarse, ...stageSamples);
  return { trace, async finish() {
    renderer.compute([reset, reduce, locate, gather, coarse, ...stageSamples]);
    const values = new Float32Array(await renderer.getArrayBufferAsync(output.value));
    const faces = [...values.slice(28, 34)], missing = [...values.slice(22, 28)];
    return { coordinate: [...values.slice(1, 4)], maxDivergence: values[4], freshPage: Boolean(values[5]),
      finePressure: values[6], rhs: values[7], fluidVolume: values[8], faces,
      weights: [...values.slice(10, 16)], neighborPressure: [...values.slice(16, 22)], missing,
      domainEdges: [...values.slice(34, 40)], brickCoordinate: [...values.slice(40, 43)],
      coarseCorrectionRHS: [...values.slice(44, 48)], coarseCoefficients: [...values.slice(48, 51)],
      fractional: faces.some(w => w > 0 && w < 1), solidFace: faces.some(w => w === 0),
      phases: phases.map((phase, i) => ({ phase, pressure: values[64 + i * 4], residual: values[65 + i * 4] })) };
  }, dispose() { nodes.forEach(node => node.dispose()); attributes.forEach(attribute => attribute.dispose()); } };
}
