import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Fn, instanceIndex, vec4, float } from 'three/tsl';
import { Emitter, EmissionShape, GasSimulation, ParticleSystem } from '@rzmps/rzmps';
import { trackSimulationTime } from '../../../benchmarks/fluids/fluidProfiling.utils.js';
import { gasMoments as readMoments } from '../../../benchmarks/fluids/gasQualityMetrics.utils.js';

const renderer = new WebGPURenderer();
await renderer.init();
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
const gasMoments = gas => readMoments(gas, renderer);

async function fixture(cells, source, operation, settings = {}) {
  const gas = new GasSimulation({ bounds: new THREE.Box3(new THREE.Vector3(-2, -2, -2), new THREE.Vector3(2, 2, 2)),
    automaticPadding: false, adaptiveTimestep: false, pressureIterations: 0,
    spatialGridOptions: { brickSubdivisions: 2, cellSubdivisions: cells, autoVolumeQuality: false,
      volumeQuality: 4, autoExpand: false }, initialBrickCapacity: 64, maxBrickCapacity: 64,
    sourceStrength: source ? 1 : 0, velocitySourceStrength: 0, buoyancy: 0, weight: 0,
    densityDissipation: 0, temperatureDissipation: 0, colorDissipation: 0, velocityDissipation: 0,
    densityCutoff: 0, scalarDiffusion: 0, turbulenceNoiseStrength: 0, vorticityStrength: 0,
    externalForce: new THREE.Vector3(), sourceTemperature: settings.temperature ?? 0,
  });
  const system = new ParticleSystem({ gpuProcessing: true, maxParticles: 1, gravity: new THREE.Vector3(),
    emitters: new Emitter({ source: EmissionShape.Sphere(1e-6, 4, 2),
      rate: 0, bursts: [{ time: 0, count: 1 }], initialValues: {
      lifetime: 100, mass: settings.mass ?? 1, alpha: settings.alpha ?? 1, speed: 1,
      position: new THREE.Vector3().fromArray(settings.position ?? [0, 0, 0]),
      color: new THREE.Color().setRGB(0.2, 0.4, 0.8),
      scale: new THREE.Vector3().setScalar(settings.scale ?? 0.1),
      velocity: new THREE.Vector3(),
    } }), modules: [gas], renderers: [] });
  scene.add(system);
  await renderer.renderAsync(scene, camera);
  const step = async () => {
    system.advanceFrames(1, 1 / 60);
    await renderer.backend.device.queue.onSubmittedWorkDone();
  };
  try {
    await system.prepare(renderer);
    await step();
    return await operation(gas, system, step);
  } finally {
    await renderer.backend.device.queue.onSubmittedWorkDone();
    system.destroy(); system.removeFromParent();
  }
}

async function seed(gas, velocity = 0) {
  const grid = gas.volumeGrid;
  renderer.compute(Fn(() => {
    grid.pages.element(instanceIndex).assign(instanceIndex.add(1));
    grid.slots.element(instanceIndex).assign(instanceIndex.add(1));
  })().compute(grid.brickCount));
  grid.updateDispatch(renderer);
  renderer.compute(gas.computeCells(index => {
    const p = gas.cellCenter(gas.cellCoordinate(index));
    const density = p.lengthSq().div(-2 * 0.35 ** 2).exp();
    gas.densityCurrent.element(index).assign(vec4(density, 0, 0, 0));
    gas.colorCurrent.element(index).assign(vec4(density, density, density, 0));
    gas.velocityCurrent.element(index).assign(vec4(velocity, 0, 0, 0));
    gas.velocityNext.element(index).assign(vec4(velocity, 0, 0, 0));
    gas.pressureCurrent.element(index).assign(float(0));
    gas.solid.element(index).assign(0);
    gas.faceOpenness.element(index).assign(vec4(1));
    gas.solidVelocity.element(index).assign(vec4(0));
  }));
}

window.measureQualityPhysics = async () => {
  const injection = [], diffusion = [];
  for (const cells of [3, 2]) {
    injection.push(await fixture(cells, true, gas => gasMoments(gas)));
    diffusion.push(await fixture(cells, false, async (gas, _system, step) => {
      await seed(gas);
      const before = await gasMoments(gas);
      gas.scalarDiffusion = 0.8 * 0.125 ** 2 / 6;
      for (let frame = 0; frame < 60; frame++) await step();
      const after = await gasMoments(gas);
      return { before, after, growth: after.variance - before.variance };
    }));
  }
  const migration = await fixture(3, false, async (gas, _system, step) => {
    await seed(gas);
    const before = await gasMoments(gas);
    gas.setSpatialGridOptions({ volumeQuality: 8 });
    await step();
    return { before, after: await gasMoments(gas) };
  });
  // Vary both voxel phase and physical support, including a point-sized source.
  const sources = [];
  for (const [cells, scale, position] of [
    [4, 0.1, [0.031, 0.02, -0.047]],
    [3, 0, [0.071, -0.04, 0.11]],
    [2, 0.9, [0.13, 0.19, -0.21]],
    [1, 0.1, [-0.17, 0.24, 0.31]],
  ]) {
    sources.push(await fixture(cells, true, async gas => {
      const density = await gasMoments(gas);
      const heat = await readMoments(gas, renderer, gas.volumeGrid, gas.densityCurrent, 1);
      const color = await Promise.all([0, 1, 2].map(channel =>
        readMoments(gas, renderer, gas.volumeGrid, gas.colorCurrent, channel)));
      return { ...density, heat: heat.mass, color: color.map(value => value.mass), scale, position };
    }, { scale, position, mass: 2, alpha: 0.4, temperature: 3 }));
  }

  const continuingSource = await fixture(3, true, async (gas, _system, step) => {
    const before = await gasMoments(gas);
    gas.setSpatialGridOptions({ volumeQuality: 8 });
    await step();
    const coarse = await gasMoments(gas);
    gas.setSpatialGridOptions({ volumeQuality: 4 });
    await step();
    return { before, coarse, refined: await gasMoments(gas) };
  });

  // Stability substeps are required independently of the velocity CFL switch.
  const stability = await fixture(4, false, async (gas, system, step) => {
    await seed(gas);
    gas.scalarDiffusion = 0.1;
    const tracking = trackSimulationTime(system);
    const before = await gasMoments(gas);
    try {
      for (let frame = 0; frame < 15; frame++) await step();
      return { before, after: await gasMoments(gas), ...tracking.time };
    } finally { tracking.restore(); }
  });
  return { injection, diffusion, migration, sources, continuingSource, stability };
};
window.ready = true;
