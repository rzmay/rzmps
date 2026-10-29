import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TaggedSelector, MeshRenderer, SpriteRenderer, Particle, ParticleSystem } from '../build/index.mjs';

const leaf = value => typeof value === 'string';
const tree = new TaggedSelector({
  outer: { red: 'red', blue: ['blue-0', 'blue-1'] },
  other: ['other-0', { extra: 'other-extra' }],
  '*': 'fallback',
}, leaf);
const value = (tags, index) => tree.values[tree.select(tags, 'stable', index)];
assert.equal(value(['outer', 'red']), 'red');
assert.equal(value(['outer', 'blue'], 0), 'blue-0');
assert.equal(value(['outer', 'blue'], -1), 'blue-1');
assert.equal(value(['outer', 'red', 'blue']), 'red');
assert.equal(value(['red']), 'fallback');
assert.equal(value(['other'], 1), 'other-0');
assert.equal(value(['other', 'extra'], 1), 'other-extra');
assert.equal(value(['outer', 'blue']), value(['outer', 'blue']));
assert.deepEqual(tree.tags, ['outer', 'red', 'blue', 'other', 'extra']);

const missing = new TaggedSelector({ first: { inner: 'a' }, second: 'b' }, leaf);
assert.equal(missing.select(['first']), -1);
assert.equal(missing.values[missing.select(['first', 'second'])], 'b');
assert.equal(new TaggedSelector({ '*': 'default', red: 'r' }, leaf).select(['red']), 0);
assert.equal(new TaggedSelector([{ red: 'r' }, { blue: 'b' }], leaf).select([]), -1);
assert.throws(() => new TaggedSelector([], leaf), /at least one/);
assert.throws(() => new TaggedSelector({}, leaf), /at least one/);
const cycle = {};
cycle.tag = cycle;
assert.throws(() => new TaggedSelector(cycle, leaf), /cycles/);
assert.throws(() => new TaggedSelector(new THREE.Vector3(), leaf), /plain tag map/);

const red = new THREE.Texture({ width: 4, height: 4 });
const blue = new THREE.Texture({ width: 4, height: 4 });
const sprite = new SpriteRenderer({ outer: { red, blue: [blue, red] } }, { textureIndex: 0 });
assert.equal(sprite.textureAtlas.sources.length, 2);
const particle = new Particle({ tags: ['outer', 'blue'] });
assert.equal(sprite.getParticleFrame(particle), 1);
sprite.textureIndex = 1;
assert.equal(sprite.getParticleFrame(particle), 0);
particle.tags = ['red'];
assert.equal(sprite.getParticleFrame(particle), -1);

// A single tagged model retains InstancedMesh, while tags still control visibility.
const geometry = new THREE.BoxGeometry();
const mesh = new MeshRenderer({ geometry: { stone: geometry } });
const system = new ParticleSystem({ emitters: [], renderers: [mesh, sprite] });
mesh.update([particle], system);
assert.ok(mesh.instances.isInstancedMesh);
assert.equal(mesh.instances.count, 0);
particle.tags = ['stone'];
mesh.update([particle], system);
assert.equal(mesh.instances.count, 1);

// Resource tags participate in the existing GPU registry independently of renderer tag filtering.
system._prepareGPUTagRegistry([]);
assert.ok(system.getGPURendererTagMask(['stone']));
assert.ok(system.getGPURendererTagMask(['outer']));
assert.ok(system.getGPURendererTagMask(['blue']));
assert.equal(mesh.tags, undefined);
assert.equal(sprite.tags, undefined);
system.destroy();
geometry.dispose();
red.dispose();
blue.dispose();
console.log('Recursive tagged choices, fallbacks, eligibility, atlas aliases and GPU tag registration passed.');
