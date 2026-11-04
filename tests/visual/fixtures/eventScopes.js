import * as THREE from 'three';
import { If, uint, vec4 } from 'three/tsl';
import { Emitter, EmissionShape, Module, Particle, ParticleSystem, SpriteRenderer, Textures } from '@rzmps/rzmps';

const eventNames = ['pulse', 'spawn', 'death', 'collision'];
const selections = [
  ['local', 'alpha', 3], ['parent', 'mass', 2], ['child', 'distortionStrength', 5],
  [['local', 'parent', 'child', 'local'], 'speed', 10],
];

function createNode(name, code) {
  const node = new ParticleSystem({
    duration: 0.2, maxParticles: 32, gravityModifier: 0,
    emitters: new Emitter({ rate: 0, bursts: [] }),
    renderers: new SpriteRenderer(Textures.Circle, { tags: ['producer'] }),
    modules: new Module(particle => {
      if (particle.angularVelocity.x === 0) {
        particle.angularVelocity.x = 1;
        for (const name of [...eventNames, 'noise']) particle.emitEvent(name, code);
      }
    }, { tags: ['producer'], modifyGPU(particle) {
      If(particle.angularVelocity.x.equal(0), () => {
        particle.angularVelocity.x.assign(1);
        for (const name of [...eventNames, 'noise']) {
          particle.emitEvent(name, [vec4(code, 0, 0, 0), vec4(1), vec4(2)]);
        }
      });
    } }),
  });
  node.name = name;
  // Different registration orders deliberately give the same event name different numeric IDs.
  for (let i = 0; i < code % 3; i++) node._registerEventType(`padding-${i}`);
  node._registerEventType('noise');
  node._registerEventType('pulse');
  node.addParticle(new Particle({ lifetime: 20, tags: ['producer'], position: new THREE.Vector3(code, 2, 0),
    alpha: 0, mass: 0, speed: 0, distortionStrength: 0, scale: new THREE.Vector3(0.15, 0.15, 0.15) }));
  return node;
}

async function readParticles(system) {
  if (!system.isGPUProcessingActive) return system.particles.filter(p => p.alive);
  return (await system.selectiveReadback(32)).filter(result => result.valid && result.particle.alive)
    .map(result => result.particle);
}

function addDeathCase(root, tagged, scope, filter = false) {
  const parent = new ParticleSystem({ gravityModifier: 0, maxParticles: 16,
    emitters: new Emitter({ rate: 0, bursts: [] }), renderers: [] });
  parent.name = `Death producer ${tagged} ${scope}`;
  parent.addParticle(new Particle({ lifetime: 0.1, tags: tagged ? ['source'] : undefined }));
  const child = new ParticleSystem({ duration: 0.1, looping: false, maxParticles: 16, gravityModifier: 0,
    emitters: new Emitter({ emitOnDeath: true, eventScope: scope, tags: ['offspring'],
      sourceTags: filter ? ['source'] : undefined,
      bursts: { time: 0, count: 1 }, initialValues: { lifetime: 0.1 } }), renderers: [],
    modules: new Module((particle, _dt, { events }) => {
      particle.mass += events.filter(event => event.source?.tags?.includes('offspring')).length;
    }, { tags: ['observer'], events: ['spawn'], modifyGPU(particle, _dt, { events, system }) {
      const mask = uint(system._getGPUTagMask(['offspring']));
      events.forEach('spawn', event => {
        If(event.particle.tagMask.bitAnd(mask).notEqual(uint(0)), () => { particle.mass.addAssign(1); });
      });
    } }),
  });
  child.name = `Death consumer ${tagged} ${scope}`;
  child.addParticle(new Particle({ tags: ['observer'], lifetime: 20, mass: 0 }));
  parent.addSubSystem(child);
  root.addSubSystem(parent);
  return { child, tagged, scope, filter };
}

export default async function createEventScopes() {
  const root = createNode('Scope ancestor', 13);
  const parent = createNode('Scope parent', 2);
  const owner = createNode('Scope owner', 3);
  const child = createNode('Scope child', 5);
  const descendant = createNode('Scope descendant', 7);
  const sibling = createNode('Scope sibling', 11);
  root.addSubSystem(parent);
  parent.addSubSystem(owner);
  parent.addSubSystem(sibling);
  owner.addSubSystem(child);
  child.addSubSystem(descendant);
  child.simulationSpace = 'local';
  child.position.x = 10;

  for (const [scope, field] of selections) {
    owner.addModule(new Module((particle, _dt, { events }) => {
      particle[field] += events.reduce((total, event) => total + (typeof event.data === 'number' ? event.data : 0), 0);
    }, { tags: ['producer'], events: eventNames, eventScope: scope,
      modifyGPU(particle, _dt, { events }) {
        for (const name of eventNames) events.forEach(name, event => { particle[field].addAssign(event.data[0].x); });
      },
    }));
    owner.addEmitter(new Emitter({ eventScope: scope, tags: [`marker-${field}`],
      source: EmissionShape.Sphere(0.001), radialSpeed: 0, bursts: { time: 0, count: 1 },
      initialValues: { lifetime: 20, mass: 1 }, onEvent: {
        pulse: data => ({ mass: data }), gpu: { pulse: data => ({ mass: data[0].x }) },
      },
    }));
  }
  const deaths = [false, true].flatMap(tagged => [undefined, ['local', 'parent']]
    .map(scope => addDeathCase(root, tagged, scope)));
  deaths.push(addDeathCase(root, true, ['local', 'parent'], true));
  const overrides = [true, false].map(override => {
    const code = override ? 17 : 19;
    const consumer = createNode(`Scope override ${override}`, code);
    const emitter = new Emitter({ eventScope: 'local', tags: ['override-marker'],
      bursts: { time: 0, count: 1 }, initialValues: { lifetime: 20, mass: 1 }, onEvent: {
        pulse: data => ({ mass: data }), gpu: { pulse: data => ({ mass: data[0].x }) },
      } });
    consumer.addEmitter(emitter);
    root.addSubSystem(consumer, override ? { eventScope: 'parent' } : {});
    return { consumer, emitter, expected: override ? 13 : code };
  });

  const sourceConsumer = createNode('Scope source attachment', 23);
  sourceConsumer.simulationSpace = 'source';
  sourceConsumer.particles[0].speed = 1;
  sourceConsumer.particles[0].velocity.x = 0.2;
  sourceConsumer.particles[0].cache();
  sourceConsumer.addEmitter(new Emitter({ eventScope: ['local', 'parent'], tags: ['source-marker'],
    source: EmissionShape.Sphere(0.001), radialSpeed: 0, bursts: { time: 0, count: 1 },
    initialValues: { lifetime: 20, mass: 1 }, onEvent: {
      pulse: data => ({ mass: data }), gpu: { pulse: data => ({ mass: data[0].x }) },
    } }));
  root.addSubSystem(sourceConsumer);

  root.userData.validateSimulationFrames = async () => {
    const particles = await readParticles(owner);
    const producer = particles.find(p => p.tags?.includes('producer'));
    if (!producer) throw new Error('Scope observer particle missing');
    const results = [];
    for (const [scope, field, expected] of selections) {
      if (producer[field] !== expected * eventNames.length) {
        throw new Error(`${JSON.stringify(scope)} module: expected ${expected * eventNames.length}, `
          + `got ${producer[field]}`);
      }
      const markers = particles.filter(p => p.tags?.includes(`marker-${field}`));
      const codes = scope === 'local' ? [3] : scope === 'parent' ? [2] : scope === 'child' ? [5] : [2, 3, 5];
      const actual = markers.map(p => p.mass).sort((a, b) => a - b);
      if (JSON.stringify(actual) !== JSON.stringify(codes)) {
        throw new Error(`${JSON.stringify(scope)} emitter: expected ${codes}, got ${actual}`);
      }
      for (const marker of markers) {
        if (marker.tags.includes('producer')) throw new Error('Birth inherited a source tag');
        const expectedX = marker.mass === 5 ? 15 : marker.mass;
        if (Math.abs(marker.position.x - expectedX) > 0.01) throw new Error('Event used the wrong producer transform');
      }
      results.push({ scope, events: producer[field], births: markers.length });
    }
    for (const { child: system, tagged, scope, filter } of deaths) {
      const observer = (await readParticles(system)).find(p => p.tags?.includes('observer'));
      if (!observer || (scope === undefined || filter ? observer.mass !== 1 : observer.mass <= 1)) {
        throw new Error(`Death scope ${scope}, tagged=${tagged}: invalid birth count ${observer?.mass}`);
      }
      results.push({ scope: scope ?? 'default-parent', tagged, births: observer.mass });
    }
    for (const { consumer, emitter, expected } of overrides) {
      const markers = (await readParticles(consumer)).filter(p => p.tags?.includes('override-marker'));
      if (markers.length !== 1 || markers[0].mass !== expected || emitter.eventScope !== 'local') {
        throw new Error(`Relationship scope override failed: expected ${expected}, got ${markers.map(p => p.mass)}`);
      }
      results.push({ scope: expected === 13 ? 'override-parent' : 'emitter-local', births: markers.length });
    }
    const sourceParticles = await readParticles(sourceConsumer);
    const sourceMarkers = sourceParticles.filter(p => p.tags?.includes('source-marker'));
    const localSource = sourceParticles.find(p => p.tags?.includes('producer'));
    const parentSource = (await readParticles(root)).find(p => p.tags?.includes('producer'));
    if (sourceMarkers.length !== 2) throw new Error('Source scope must emit from both selected producers');
    for (const marker of sourceMarkers) {
      const source = marker.mass === 23 ? localSource : parentSource;
      const world = sourceConsumer.simulationToWorld(marker.position.clone());
      const frame = marker.mass === 23 ? sourceConsumer : root;
      if (!source || world.distanceTo(frame.simulationToWorld(source.position.clone())) > 0.01) {
        throw new Error(`Source scope lost producer attachment ${marker.mass}`);
      }
    }
    results.push({ scope: 'source-local-parent', births: sourceMarkers.length });
    for (const system of [root, parent, owner, child, descendant, sibling, sourceConsumer, ...deaths.map(d => d.child),
      ...overrides.map(value => value.consumer)]) {
      if (system.gpuEventStats.readbackCount !== 0) throw new Error('GPU-native scopes requested event readback');
    }
    return results;
  };
  return root;
}
