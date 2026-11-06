import * as THREE from 'three';
import { If, float, vec3, vec4 } from 'three/tsl';
import { ParticleSystem, Emitter, EmissionShape, Module, SpriteRenderer, Textures } from '@rzmps/rzmps';

// Deterministic affine motion makes attachment errors observable numerically on both backends.
export default function createSimulationSpaces() {
  const parent = new ParticleSystem({
    gravityModifier: 0, duration: 20, maxParticles: 1,
    emitters: new Emitter({ source: EmissionShape.Box(0.0001, 0.0001, 0.0001), tags: ['insect'],
      bursts: { time: 0, count: 1 }, initialValues: { lifetime: 1.25, rotation: 0 } }),
    modules: new Module(p => {
      const age = p.realtime / 1000;
      p.position.set(age * 2, 2, 0);
      p.rotation.set(age * 0.2, age * 0.3, age);
      p.scale.setScalar(1 + age * 0.25);
      if (p.mass === 0) { p.mass = 1; p.emitEvent('pulse', { strength: 1 }); }
    }, { modifyGPU(p) {
      const age = p.realtime.div(1000);
      p.position.assign(vec3(age.mul(2), 2, 0));
      p.rotation.assign(vec3(age.mul(0.2), age.mul(0.3), age));
      p.scale.assign(vec3(age.mul(0.25).add(1)));
      If(p.mass.equal(0), () => { p.mass.assign(1); p.emitEvent('pulse', vec4(1)); });
    } }),
    renderers: [],
  });
  parent.name = 'Frame Origins';
  const children = [];
  for (const kind of ['native', 'registered', 'continuous', 'detached']) {
    const glow = new ParticleSystem({
      simulationSpace: 'source', sourceLoss: kind === 'detached' ? 'detach' : 'kill',
      gravityModifier: 0, duration: 2, maxParticles: 16,
      emitters: new Emitter({ source: EmissionShape.Box(0.0001, 0.0001, 0.0001), radialSpeed: 0,
        bursts: [{ time: 0, count: 1 }, { time: 0.4, count: 1 }, { time: 0.8, count: 1 }],
        initialValues: { position: new THREE.Vector3(1, 0, 0), lifetime: 10, scale: 0.2, rotation: 0 } }),
      renderers: new SpriteRenderer(Textures.Simple),
    });
    glow.name = `Source ${kind}`;
    parent.addSubSystem(glow, { inheritLifetime: 0, inheritScale: 1, inheritColor: 0,
      tags: kind === 'registered' ? ['managed'] : ['insect'],
      ...(kind === 'continuous' ? { emitContinuous: true } : { onEvent: {
        pulse: () => ({}), gpu: { pulse: () => ({ scale: float(1) }) },
      } }),
    });
    children.push(glow);
  }
  const audit = new ParticleSystem({
    simulationSpace: 'world', gravityModifier: 0, duration: 0.1, maxParticles: 16,
    emitters: new Emitter({ source: EmissionShape.Box(0.0001, 0.0001, 0.0001), radialSpeed: 0,
      bursts: {time: 0, count: 1}, initialValues: {lifetime: 10, rotation: 0} }), renderers: [],
  });
  audit.name = 'Valid Source Births';
  children[0].addSubSystem(audit, {emitOnSpawn: true, inheritLifetime: 0});
  const managed = parent.registerEmissionSource({ transform: new THREE.Matrix4().makeTranslation(-3, 2, 0),
    tags: ['managed'] });
  managed.emitEvent('pulse');
  const anchor = new THREE.Object3D(); anchor.position.set(0, 1, -3);
  const transformed = new ParticleSystem({
    simulationSpace: 'transform', simulationSpaceTransform: anchor,
    gravityModifier: 0, duration: 20, maxParticles: 2,
    emitters: new Emitter({ source: EmissionShape.Box(0.0001, 0.0001, 0.0001),
      radialSpeed: 0, bursts: { time: 0, count: 1 },
      initialValues: { lifetime: 10, rotation: 0, scale: 0.2 } }),
    renderers: new SpriteRenderer(Textures.Simple),
  });
  transformed.position.set(-2, 3, -3); transformed.name = 'Transform Frame';
  parent.add(transformed);
  // The harness calls this after all steps. Move the external reference and verify rendering uses it live.
  parent.userData.validateSimulationFrames = async () => {
    const read = async system => {
      if (!system.isGPUProcessingActive) return system.particles.filter(p => p.alive);
      const results = await system._readbackGPUParticles(Array.from({length: system.gpuParticleBuffers.count},
        (_, slot) => ({slot, generation: 0})));
      return results.filter(r => r.valid).map(r => r.particle);
    };
    const origins = await read(parent), result = [];
    if (origins.length !== 1) throw new Error('Fixture must have one live native source');
    const origin = origins[0];
    const matrix = new THREE.Matrix4().compose(origin.position,
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...origin.rotation.toArray())), origin.scale);
    for (const child of children) {
      const particles = await read(child);
      const expected = child === children[1] ? new THREE.Vector3(-2, 2, 0)
        : new THREE.Vector3(1, 0, 0).applyMatrix4(matrix);
      if (particles.length < (child === children[2] ? 1 : 2)) {
        throw new Error(`${child.name} must retain its births (received ${particles.length})`);
      }
      for (const p of particles) {
        if (p.position.distanceTo(expected) > 0.005) {
          throw new Error(`${child.name}: ${p.position.toArray()} != ${expected.toArray()}`);
        }
      }
      result.push({system: child.name, particles: particles.length, attachment: 'passed'});
    }
    const detached = await read(children[3]);
    const detachedIDs = new Set(detached.map(p => p.id));
    parent.advanceFrames(40, 1 / 60);
    if ((await read(audit)).length !== 2) throw new Error('Canceled source births emitted downstream spawn effects');
    for (const child of [children[0], children[2]]) {
      if ((await read(child)).length) throw new Error(`${child.name} survived its source with sourceLoss: kill`);
    }
    const frozen = (await read(children[3])).filter(p => detachedIDs.has(p.id));
    if (frozen.length !== detached.length) throw new Error('Detach must retain existing particles');
    parent.emitters[0].rate = 4;
    parent.advanceFrames(20, 1 / 60);
    const replacement = await read(parent);
    if (!replacement.length) throw new Error('A replacement source must occupy the recycled slot');
    const afterReuse = await read(children[3]);
    for (const p of frozen) {
      const retained = afterReuse.find(other => other.id === p.id);
      if (!retained || retained.position.distanceTo(p.position) > 1e-5) {
        throw new Error('Detached particles followed a reused source slot');
      }
    }
    result.push({sourceLoss: 'passed', recycledSource: 'passed'});
    const before = transformed.getSimulationToWorldMatrix();
    anchor.position.x += 5;
    const after = transformed.getSimulationToWorldMatrix();
    if (Math.abs(after.elements[12] - before.elements[12] - 5) > 1e-6) throw new Error('External transform is stale');
    transformed.advanceFrames(1, 1 / 60);
    transformed.syncRendererParents();
    const poseBefore = transformed.simulationToWorld((await read(transformed))[0].position.clone());
    const rendererFrame = transformed.getRendererParent().getWorldPosition(new THREE.Vector3());
    if (rendererFrame.distanceTo(anchor.position) > 1e-5) throw new Error('Renderer did not follow the custom frame');
    transformed.simulationSpace = 'world';
    transformed.advanceFrames(1, 1 / 60);
    const poseAfter = (await read(transformed))[0].position;
    if (poseAfter.distanceTo(poseBefore) > 1e-5) throw new Error('GPU frame conversion changed the world pose');
    result.push({system: transformed.name, transform: 'passed', modeConversion: 'passed'});
    return result;
  };
  return parent;
}
