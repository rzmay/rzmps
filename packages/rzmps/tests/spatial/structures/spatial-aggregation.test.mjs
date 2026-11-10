import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { Particle, ParticleOctree, ParticleSpatialGrid, SpatialLevels } from '../../../build/index.mjs';
import { ParticleSystem } from '../../../build/index.mjs';

const levels = value => new ParticleSpatialGrid({ brickSubdivisions: 2, cellSubdivisions: 3, levels: value }).levels;
for (const value of [undefined, SpatialLevels.None, 'none', 'None']) assert.deepEqual(levels(value), [5]);
for (const value of [SpatialLevels.Bricks, 'bricks', 'Bricks']) assert.deepEqual(levels(value), [0, 1, 2, 5]);
for (const value of [SpatialLevels.Cells, 'cells', 'Cells']) assert.deepEqual(levels(value), [2, 3, 4, 5]);
for (const value of [SpatialLevels.All, '*', 'All']) assert.deepEqual(levels(value), [0, 1, 2, 3, 4, 5]);
const requested = Object.freeze([4, 0, 4]);
assert.deepEqual(levels(requested), [0, 4, 5]);
assert.deepEqual(requested, [4, 0, 4]);
for (const value of [[-1], [6], [1.2], [NaN], [Infinity], 'bad']) assert.throws(() => levels(value), RangeError);
assert.deepEqual(new ParticleSpatialGrid({ brickSubdivisions: 0, cellSubdivisions: 0,
  levels: SpatialLevels.All }).levels, [0]);

let nodeArguments = 0;
const tree = new ParticleOctree({ bounds: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
  particlesPerLeaf: 1 }, {
  new(p, index, node) {
    assert(node); nodeArguments++;
    return { count: p ? 1 : 0, sum: p?.position.x ?? 0, mean: 0 };
  },
  combine: (a, b) => ({ count: a.count + b.count, sum: a.sum + b.sum, mean: 0 }),
  finalize: a => ({ ...a, mean: a.sum / Math.max(1, a.count) }),
});
tree.rebuild([-0.75, -0.25, 0.5].map(x => new Particle({ position: new Vector3(x, 0, 0) })));
assert(nodeArguments > 3);
assert.equal(tree.root.aggregate.count, 3);
assert.equal(tree.root.aggregate.mean, 0);
assert.equal(tree.getAggregate(tree.root).mean, -0.5 / 3);
assert.equal(tree.root.aggregate.sum, -0.5, 'Finalization leaves raw parent reduction intact');
const children = tree.getChildren(tree.root);
assert(children.length > 0 && children.every(child => !child.isEmpty));
assert.equal(children.reduce((n, child) => n + tree.getAggregate(child).count, 0), 3);
assert(tree.getBounds().containsPoint(new Vector3(0.5, 0, 0)));
assert.deepEqual(tree.getChildren(tree.locate(new Vector3(-0.75, 0, 0))), []);
const mutating = new ParticleOctree({}, {
  new: p => ({ sum: p ? 3 : 0, count: p ? 1 : 0, vector: new Vector3(p ? 2 : 0, 0, 0) }),
  combine: (a, b) => ({ sum: a.sum + b.sum, count: a.count + b.count, vector: a.vector.clone().add(b.vector) }),
  finalize: a => { a.sum /= a.count; a.vector.divideScalar(a.count); return a; },
});
mutating.rebuild([new Particle(), new Particle()]);
assert.equal(mutating.getAggregate(mutating.root).sum, 3);
assert.equal(mutating.root.aggregate.sum, 6);
assert.equal(mutating.root.aggregate.vector.x, 4, 'Mutating finalization cannot normalize raw vector state');
const system = new ParticleSystem({ emitters: [], renderers: [], modules: [] });
const ordinary = system.acquireParticleSpatialGrid();
const hierarchy = system.acquireParticleSpatialGrid({ levels: 'All' });
assert.notEqual(ordinary, hierarchy, 'Managed grids include maintained levels in their compatibility key');
assert.equal(hierarchy, system.acquireParticleSpatialGrid({ levels: '*' }));
assert.equal(ordinary, system.acquireParticleSpatialGrid({ levels: 'None' }));
system.destroy();
console.log('Spatial levels, CPU aggregation compatibility and finalization passed.');
