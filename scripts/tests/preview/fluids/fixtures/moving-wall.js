import * as THREE from 'three';
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu';
import { Fn, storage, vec3, vec4 } from 'three/tsl';
import { ThreeGPUCollisionBackend } from '@rzmps/rzmps';

const renderer = new WebGPURenderer();
renderer.setSize(64, 64);
await renderer.init();
const geometry = new THREE.BoxGeometry(0.04, 4, 4);
const wall = new THREE.Mesh(geometry);
wall.position.x = -1;
const backend = new ThreeGPUCollisionBackend({ dynamicObjects: [wall], sweptMotion: true });
backend.update(1 / 60, {});
const output = new StorageBufferAttribute(new Float32Array(16), 4);
const values = storage(output, 'vec4', 4);
const read = async (point, motion = true) => {
  renderer.compute(Fn(() => {
    const p = vec3(...point);
    const hit = motion ? backend.queryMovingCapsule(p, p, vec3(0.05).x)
      : backend.queryCapsule(p, p, vec3(0.05).x);
    values.element(0).assign(vec4(hit.get('point'), hit.get('found').select(1, 0)));
    values.element(1).assign(vec4(hit.get('capsulePoint'), hit.get('fraction')));
    values.element(2).assign(vec4(hit.get('normal'), hit.get('distanceSq')));
    values.element(3).assign(vec4(hit.get('wallDisplacement'), 0));
  })().compute(1));
  return [...new Float32Array(await renderer.getArrayBufferAsync(output))];
};
window.runMovingWall = async () => {
  const initial = backend.hasMotion;
  wall.position.x = 1;
  const token = {};
  backend.update(1 / 60, token);
  const current = await read([0, 0, 0], false);
  const swept = await read([0, 0, 0]);
  backend.update(1 / 60, token);
  const repeated = await read([0, 0, 0]);
  backend.update(1 / 60, {});
  const stationary = backend.hasMotion;
  wall.position.x = 0;
  backend.update(1 / 60, {});
  backend.update(1 / 60, {});
  wall.rotation.z = Math.PI / 2;
  backend.update(1 / 60, {});
  const rotating = await read([-0.5, 0.5, 0]);
  const stats = { ...backend.stats };
  backend.destroy();
  geometry.dispose();
  return { initial, current, swept, repeated, stationary, rotating, stats };
};
window.ready = true;
