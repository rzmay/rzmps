import * as THREE from 'three';
import { Easing } from 'eaz';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import teapotModel from '../assets/models/utah_teapot_quad_wide_spout.obj?url';
import studioEnvironment from '../assets/images/ferndale_studio_11_1k.hdr?url';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from '../utils/particleRoot.js';

export default async function createFluidTeapot(scene) {
  const previousEnvironment = scene.environment;
  const environment = await new HDRLoader().loadAsync(studioEnvironment);
  environment.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = environment;
  const root = new THREE.Group();
  root.name = 'Fluid Teapot Scene';
  const vessel = new THREE.Group();
  vessel.name = 'Teapot Tip Pivot';
  root.add(vessel);
  const particleRoot = createSceneParticleRoot(scene, [0, 2.55, 0]);
  const material = new THREE.MeshPhysicalMaterial({
    color: '#cbd5dc',
    roughness: 0.22,
    metalness: 0.15,
    clearcoat: 0.45,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: '#25272b',
    roughness: 0.88,
  });

  const teapot = await new OBJLoader().loadAsync(teapotModel);
  teapot.name = 'Lidless Utah Teapot';
  teapot.scale.setScalar(0.76);
  teapot.position.y = -0.43;
  teapot.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = material;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  const modelBounds = new THREE.Box3().setFromObject(teapot);
  const pivotHeight = modelBounds.getCenter(new THREE.Vector3()).y;
  vessel.position.y = pivotHeight;
  teapot.position.y -= pivotHeight;
  vessel.add(teapot);

  const support = getTippingSupport(teapot, vessel);
  const tipping = { tip: 0, automaticTipping: true, maximumTip: 45, period: 20, tipSpeed: 30 };
  let appliedTip = 0;
  let elapsed = 0;
  const applyTip = () => {
    vessel.rotation.z = -THREE.MathUtils.degToRad(appliedTip);
    const lowest = Math.min(...support.map(point => point.x * Math.sin(vessel.rotation.z)
      + point.y * Math.cos(vessel.rotation.z)));
    // Lift the vessel as it rotates so neither its body nor its spout enters the floor.
    vessel.position.y = Math.max(pivotHeight, -0.43 - lowest);
    vessel.updateWorldMatrix(true, true);
  };

  const floor = new THREE.Mesh(new THREE.BoxGeometry(18, 0.2, 14), floorMaterial);
  floor.name = 'Fluid Studio Floor';
  floor.position.y = -0.62;
  floor.receiveShadow = true;
  root.add(floor);

  const hemisphere = new THREE.HemisphereLight('#edf7ff', '#75504a', 1.3);
  const key = new THREE.DirectionalLight('#fff2dc', 3.5);
  key.position.set(-5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const rim = new THREE.PointLight('#61b9ff', 55, 14, 2);
  rim.position.set(4.5, 4, 3.5);
  root.add(hemisphere, key, rim);

  scene.background = new THREE.Color('#17191c');
  scene.add(root);

  const cleanup = () => {
    if (scene.environment === environment) scene.environment = previousEnvironment;
    environment.dispose();
    disposeSceneParticleRoot(scene, particleRoot);
    root.removeFromParent();
    const geometries = new Set();
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) geometries.add(object.geometry);
    });
    geometries.forEach((geometry) => geometry.dispose());
    material.dispose();
    floorMaterial.dispose();
  };

  return {
    update: (deltaTime) => {
      if (!Number.isFinite(deltaTime) || deltaTime <= 0) return;
      const dt = Math.min(deltaTime, 0.1);
      if (tipping.automaticTipping) {
        elapsed += dt;
        const phase = (elapsed % tipping.period) / tipping.period;
        // Linear rise, hold and return; apply easing only once below.
        const amount = THREE.MathUtils.clamp(
          Math.min((phase - 0.45) / 0.15, (0.85 - phase) / 0.15), 0, 1,
        );
        tipping.tip = Easing.cubic.inOut(amount) * tipping.maximumTip;
      }
      const change = THREE.MathUtils.clamp(tipping.tip - appliedTip, -tipping.tipSpeed * dt, tipping.tipSpeed * dt);
      if (Math.abs(change) < 1e-9) return;
      appliedTip += change;
      applyTip();
    },
    gui: (folder) => {
      folder.add(tipping, 'tip', 0, 105, 0.5).name('Tip (Degrees)').listen().onChange(() => {
        tipping.automaticTipping = false;
      });
      folder.add(tipping, 'tipSpeed', 5, 90, 1).name('Tip Speed (Degrees/Second)');
      folder.add(tipping, 'automaticTipping').name('Automatic Tipping').listen().onChange(() => {
        elapsed = 0;
        if (!tipping.automaticTipping) tipping.tip = appliedTip;
      });
      folder.add(tipping, 'maximumTip', 0, 105, 0.5).name('Automatic Tip Angle');
      folder.add(tipping, 'period', 5, 90, 1).name('Tip Period (Seconds)').onChange(() => { elapsed = 0; });
    },
    cleanup,
  };
}

/** Exact floor support under Z rotation, reduced once to a small 2D convex hull. */
function getTippingSupport(model, pivot) {
  pivot.updateWorldMatrix(true, true);
  const inverse = pivot.matrixWorld.clone().invert(), points = [];
  const point = new THREE.Vector3();

  model.traverse(object => {
    if (!object.isMesh) return;
    const matrix = inverse.clone().multiply(object.matrixWorld), position = object.geometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(matrix);
      points.push(new THREE.Vector2(point.x, point.y));
    }
  });

  // A bounding box includes empty space below the spout and exaggerates the required lift.
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const chains = [points, [...points].reverse()].map(ordered => {
    const chain = [];
    for (const point of ordered) {
      while (chain.length >= 2 && turn(chain.at(-2), chain.at(-1), point) <= 0) chain.pop();
      chain.push(point);
    }
    return chain.slice(0, -1);
  });
  return chains.flat();
}

createFluidTeapot.author = 'rzmay';
createFluidTeapot.description = 'A lidless Utah teapot filled from above by the FLIP liquid preset.';

createFluidTeapot.metadata = { id: 'fluidTeapot', title: 'Fluid Teapot', author: 'rzmay' };
