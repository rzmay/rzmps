import assert from 'node:assert/strict';
import test from 'node:test';
import traceComputeBuilds from '../../apps/demo/benchmarks/fluids/traceComputeBuilds.js';

test('compute build tracing excludes async waits, avoids nested double counting and releases hooks', async () => {
  const records = [];
  let visited = 0;
  const previous = () => { visited++; };
  const renderer = { debug: { onNodeBuilderCreated: previous } };
  const node = { isComputeNode: true, name: 'test.sampling', build() { return 7; } };
  const builder = {
    stage: 'setup', getBuildStage() { return this.stage; },
    prebuild() {}, flowNode(value) { return value.build(this); }, buildCode() {}, buildUpdateNodes() {},
    async buildAsync() {
      this.prebuild();
      assert.equal(node.build(this), 7);
      await Promise.resolve();
      this.stage = 'generate';
      this.flowNode(node);
      this.buildCode(); this.buildUpdateNodes();
    },
    build() {},
  };
  const originalNode = node.build, originalAsync = builder.buildAsync, originalFlow = builder.flowNode;
  const restore = traceComputeBuilds(renderer, record => records.push(record));
  renderer.debug.onNodeBuilderCreated(builder, node);
  await builder.buildAsync();
  assert.equal(visited, 1, 'preserve an existing diagnostic callback');
  assert.deepEqual(records.map(record => record.stage), ['prebuild', 'setup', 'generate', 'code', 'updates']);
  assert(records.every(record => record.cpuMs >= 0 && record.family === 'test.sampling'));
  assert.equal(node.build, originalNode);
  assert.equal(builder.buildAsync, originalAsync);
  assert.equal(builder.flowNode, originalFlow);
  restore();
  assert.equal(renderer.debug.onNodeBuilderCreated, previous);
});
