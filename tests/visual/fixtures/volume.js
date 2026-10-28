import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { Module, ParticleSystem, VolumeRenderer } from '@rzmps/rzmps';

const gpu = new URLSearchParams(location.search).get('backend') === 'webgpu';
const renderer = gpu ? new WebGPURenderer({
  reversedDepthBuffer: new URLSearchParams(location.search).has('reversed'),
}) : new THREE.WebGLRenderer();
renderer.setSize(480, 320);
renderer.setPixelRatio(1);
renderer.setClearColor(0);
document.body.append(renderer.domElement);
if (gpu) await renderer.init();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 480 / 320, 0.1, 30);
camera.position.z = 6;

class Source extends Module {
  constructor(minX, maxX, resolution, density, color, tag) {
    super(() => {}, { tags: [tag] });
    const bounds = new THREE.Box3(new THREE.Vector3(minX, -1, -0.5), new THREE.Vector3(maxX, 1, 0.5));
    this.density = {
      data: new Float32Array(resolution ** 3).fill(density),
      bounds, resolution: new THREE.Vector3(resolution, resolution, resolution), version: 0,
    };
    this.color = { ...this.density, channels: 4, data: new Float32Array(resolution ** 3 * 4) };
    for (let i = 0; i < this.color.data.length; i += 4) this.color.data.set([...color, 1], i);
  }
  getVolumeField() { return this.density; }
  getVolumeColorField() { return this.color; }
}
const red = new Source(-1.5, 0.5, 8, 0.5, [1, 0, 0], 'red');
const blue = new Source(-0.5, 1.5, 16, 1.5, [0, 0, 1], 'blue');
const volume = new VolumeRenderer({ generateChildren: false, steps: 64, threshold: 0.1, range: 0.05, opacity: 0.08,
  children: { count: 1000 }, compensation: 'children' });
const system = new ParticleSystem({ emitters: [], modules: [red, blue], renderers: [] });
scene.add(system);
if (gpu) await renderer.renderAsync(scene, camera);
else renderer.render(scene, camera);
system.addRenderer(volume);
window.renderVolume = async tags => {
  volume.tags = tags;
  volume.update([], system, 0);
  if (gpu) await renderer.renderAsync(scene, camera);
  else renderer.render(scene, camera);
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  context.drawImage(renderer.domElement, 0, 0);
  const pixel = x => [...context.getImageData(x, 160, 1, 1).data];
  return {
    left: pixel(140), middle: pixel(240), right: pixel(340), outside: pixel(450),
    layers: volume.layers.length, bounds: [volume.bounds.min.toArray(), volume.bounds.max.toArray()],
    children: volume.renderedChildCount,
  };
};
window.volumeFixture = { red, blue, volume, system, renderer, scene, camera, THREE };
await window.renderVolume();
window.ready = true;
