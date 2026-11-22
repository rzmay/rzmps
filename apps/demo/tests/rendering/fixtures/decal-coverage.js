import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { float, texture, sin, mx_fractal_noise_float } from 'three/tsl';
import { DecalRenderer, Particle, ParticleSystem, Textures, perturbNormal } from '@rzmps/rzmps';

const backend = new URLSearchParams(location.search).get('backend') ?? 'webgpu';
const renderer =
  backend === 'webgl'
    ? new THREE.WebGLRenderer({ antialias: false, stencil: true })
    : new WebGPURenderer({ antialias: false, stencil: true, trackTimestamp: true });
await renderer.init?.();
renderer.setSize(256, 256);
renderer.setPixelRatio(1);
document.body.append(renderer.domElement);
const fence = async () => {
  if (renderer.backend?.device) await renderer.backend.device.queue.onSubmittedWorkDone();
  else renderer.getContext().finish();
};
const scene = new THREE.Scene();
scene.background = new THREE.Color('white');
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
let receiver = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 8),
  new THREE.MeshBasicMaterial({
    color: 'white',
    stencilWrite: true,
    stencilRef: 0x81,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  }),
);
receiver.rotation.x = -Math.PI / 2;
scene.add(receiver, new THREE.AmbientLight('white', 2));
// This unrelated consumer relies on bit 0x01 surviving the coverage reset and decal coverage writes.
const probe = new THREE.Mesh(
  new THREE.PlaneGeometry(0.15, 0.15),
  new THREE.MeshBasicMaterial({
    color: '#00ff00',
    transparent: true,
    depthWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.EqualStencilFunc,
    stencilRef: 1,
    stencilFuncMask: 1,
    stencilWriteMask: 0,
  }),
);
probe.position.set(-0.9, -0.9, 0.005);
probe.renderOrder = 0;
receiver.add(probe);
const light = new THREE.DirectionalLight('white', 2);
light.position.set(1, 4, 2);
scene.add(light);
const map = await new THREE.TextureLoader().loadAsync(Textures.Simple);
const target =
  backend === 'webgl'
    ? new THREE.WebGLRenderTarget(256, 256, { stencilBuffer: true })
    : new THREE.RenderTarget(256, 256, { stencilBuffer: true });

// Each pass sees the same receiver-local detail, independent of decal UVs and rigid world pose.
function createView(union = true, detail = false, options = {}) {
  const material = new THREE.MeshStandardMaterial({
    color: detail ? 'white' : '#343a40',
    map,
    roughness: 0.08,
    metalness: 0,
    opacity: 0.35,
    alphaTest: 0.001,
    transparent: true,
    depthWrite: false,
  });
  const view = new DecalRenderer(material, {
    inheritMaterial: false,
    unionCoverage: union,
    maxDecals: 10000,
    size: options.size ?? 1.5,
    lifetime: 100,
    materialCompositeGPU: (_source, dest, context) => {
      const mask = texture(map).a;
      const p = context.receiverPositionLocal;
      const height =
        options.frequency === undefined
          ? sin(p.x.mul(11))
              .add(sin(p.y.mul(9)))
              .mul(0.1)
          : mx_fractal_noise_float(p.mul(options.frequency), options.octaves, 2, 0.5);
      const normal = perturbNormal(height, context.geometricNormal, float(options.strength ?? 0.12));
      return {
        opacity: dest.opacity.div(mask.max(0.00001)).mul(mask.greaterThanEqual(0.5).select(1, 0)),
        color: detail ? normal.mul(0.5).add(0.5) : dest.color,
        normal,
      };
    },
    materialComposite: (_source, dest, context) => {
      context.function(
        'wetBump',
        `vec3 wetBump(vec3 p, vec3 n, float h) {
        vec3 dx = dFdx(p), dy = dFdy(p);
        vec3 t = cross(dy, n), b = cross(n, dx);
        float d = dot(dx, t);
        vec3 g = (t * dFdx(h) + b * dFdy(h)) * sign(d) / max(abs(d), 0.000001);
        return normalize(n - g / max(length(g), 1.0) * 0.12);
      }`,
      );
      const p = context.receiverPositionLocal;
      const normal = `wetBump(-vViewPosition, ${context.geometricNormal},
        (sin(${p}.x * 11.0) + sin(${p}.y * 9.0)) * 0.1)`;
      return {
        opacity: `${dest.opacity} / max(texture2D(map, vMapUv).a, 0.00001)
          * step(0.5, texture2D(map, vMapUv).a)`,
        color: detail ? `(${normal} * 0.5 + 0.5)` : dest.color,
        normal,
      };
    },
  });
  const system = new ParticleSystem({ gpuProcessing: false, emitters: [], renderers: [view] });
  scene.add(system);
  return { system, view, material };
}

function pose(moving = false) {
  receiver.position.set(moving ? 0.6 : 0, moving ? 0.4 : 0, moving ? -0.2 : 0);
  receiver.rotation.set(-Math.PI / 2, moving ? 0.3 : 0, moving ? 0.2 : 0);
  scene.updateMatrixWorld(true);
  camera.position.copy(new THREE.Vector3(0, 0, 3).applyMatrix4(receiver.matrixWorld));
  camera.up.copy(new THREE.Vector3(0, 1, 0).transformDirection(receiver.matrixWorld));
  camera.lookAt(receiver.position);
  // Light stays in the same frame for a direct image comparison of receiver-attached detail.
  light.position.copy(new THREE.Vector3(1, 2, 4).applyMatrix4(receiver.matrixWorld));
}

function spawn(system, point = new THREE.Vector3(), roll = 0, velocity = new THREE.Vector3()) {
  const position = point
    .clone()
    .add(new THREE.Vector3(0, 0, 0.1))
    .applyMatrix4(receiver.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(receiver.matrixWorld);
  system.renderers[0].direction = direction;
  system._notifySpawn(new Particle({ position, velocity, rotation: new THREE.Vector3(0, 0, roll), lifetime: 100 }));
}

async function capture() {
  renderer.setRenderTarget(target);
  // Deliberately retain stencil between frames; the union's masked reset must clear only bit 0x80.
  renderer.autoClear = false;
  renderer.clear(true, true, false);
  if (renderer.renderAsync) await renderer.renderAsync(scene, camera);
  else renderer.render(scene, camera);
  await fence();
  const pixels = new Uint8Array(
    await renderer.readRenderTargetPixelsAsync(
      target,
      0,
      0,
      256,
      256,
      ...(backend === 'webgl' ? [new Uint8Array(256 * 256 * 4)] : []),
    ),
  );
  renderer.setRenderTarget(null);
  renderer.autoClear = true;
  return pixels;
}

const mismatch = (a, b, roi = false) => {
  let count = 0;
  for (let y = roi ? 110 : 0; y < (roi ? 146 : 256); y++) {
    for (let x = roi ? 110 : 0; x < (roi ? 146 : 256); x++) {
      const i = (y * 256 + x) * 4;
      for (let c = 0; c < 3; c++) if (Math.abs(a[i + c] - b[i + c]) > 3) count++;
    }
  }
  return count;
};

window.checkDecalCoverage = async () => {
  pose();
  const images = [],
    counts = [];
  for (const count of [1, 2, 10]) {
    const { system, view, material } = createView();
    for (let i = 0; i < count; i++) spawn(system);
    images.push(await capture());
    counts.push(view.batchDiagnostics.batchCount);
    if (view.appearance) throw new Error('Source-less decal coverage allocated material-copy resources');
    system.destroy();
    material.dispose();
  }
  const { system, view, material } = createView(true, true);
  spawn(system);
  const single = await capture();
  view.warp = DecalRenderer.Warp.Perspective(new THREE.Vector2(0.35, -0.2));
  spawn(system, new THREE.Vector3(0.18, 0, 0), 1.2);
  const adjacent = await capture();
  view.decals[0].mesh.setVisibleAt(view.decals[0].slot.instance, false);
  const warpedOnly = await capture();
  view.decals[0].mesh.setVisibleAt(view.decals[0].slot.instance, true);
  const before = view.decals[0].geometry.getAttribute('position').array.slice();
  pose(true);
  view.update([], system, 0);
  const moved = await capture();
  const repeated = await capture();
  const stableGeometry = before.every(
    (value, i) => value === view.decals[0].geometry.getAttribute('position').array[i],
  );
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(adjacent), 256, 256), 0, 0);
  const image = canvas.toDataURL('image/png');
  const sourceLess = !view.appearance;
  view.update([], system, 101);
  const expired = await capture();
  view.clear();
  const clear = await capture();
  system.destroy();
  material.dispose();
  pose();
  const multi = createView(true, true);
  spawn(multi.system);
  const firstReceiver = await capture();
  const original = receiver;
  receiver = original.clone();
  scene.add(receiver);
  original.position.x = 10;
  pose();
  multi.view.update([], multi.system, 0);
  spawn(multi.system);
  const secondReceiver = await capture();
  const sharedReceivers = multi.view.batchDiagnostics.batchCount;
  const differentReceivers = mismatch(firstReceiver, secondReceiver);
  multi.system.destroy();
  multi.material.dispose();
  receiver.removeFromParent();
  receiver = original;
  pose();
  let preservedStencil = 0;
  for (let i = 0; i < clear.length; i += 4) {
    if (clear[i + 1] > 200 && clear[i] < 20 && clear[i + 2] < 20) preservedStencil++;
  }
  let haloPixels = 0;
  for (let x = 60; x < 196; x++) {
    const value = images[0][(128 * 256 + x) * 4];
    if (value > 200 && value < 250) haloPixels++;
  }
  return {
    sharedReceivers,
    differentReceivers,
    preservedStencil,
    haloPixels,
    expiredCenter: Array.from(expired.slice((128 * 256 + 128) * 4, (128 * 256 + 128) * 4 + 3)),
    overlap: [mismatch(images[0], images[1]), mismatch(images[0], images[2])],
    counts,
    warpDetail: mismatch(single, warpedOnly, true),
    adjacent: mismatch(single, adjacent, true),
    moved: mismatch(adjacent, moved),
    repeat: mismatch(moved, repeated),
    stableGeometry,
    sourceLess,
    center: Array.from(images[0].slice((128 * 256 + 128) * 4, (128 * 256 + 128) * 4 + 3)),
    clearCenter: Array.from(clear.slice((128 * 256 + 128) * 4, (128 * 256 + 128) * 4 + 3)),
    image,
  };
};

window.ready = true;

