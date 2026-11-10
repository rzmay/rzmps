import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { FluidCollider } from '@rzmps/rzmps';
import teapotModel from '../assets/models/utah_teapot_quad.obj?url';
import studioEnvironment from '../assets/images/ferndale_studio_11_1k.hdr?url';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from '../utils/particleRoot.js';

function createTeapotColliderGeometry(source) {
  // Collision only needs positions; UV and normal seams must not prevent welding.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', source.getAttribute('position').clone());
  return mergeVertices(geometry, 1e-4);
}

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
  let teapotGeometry;
  teapot.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    teapotGeometry ??= object.geometry;
    object.material = material;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  const modelBounds = new THREE.Box3().setFromObject(teapot);
  const pivotHeight = modelBounds.getCenter(new THREE.Vector3()).y;
  vessel.position.y = pivotHeight;
  teapot.position.y -= pivotHeight;
  vessel.add(teapot);
  if (teapotGeometry) {
    const collider = new FluidCollider({
      geometry: createTeapotColliderGeometry(teapotGeometry),
      surfaceThickness: 0.02,
      gridOccupancy: true,
      bakedFieldResolution: 48,
      particleCollision: true,
      updatePolicy: 'transform-dynamic',
    });
    collider.name = 'Utah Teapot Fluid Collider';
    collider.position.copy(teapot.position);
    collider.quaternion.copy(teapot.quaternion);
    collider.scale.copy(teapot.scale);
    vessel.add(collider);
  }

  const localBounds = modelBounds.clone().translate(new THREE.Vector3(0, -pivotHeight, 0));
  const corners = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
    i & 1 ? localBounds.max.x : localBounds.min.x,
    i & 2 ? localBounds.max.y : localBounds.min.y,
    i & 4 ? localBounds.max.z : localBounds.min.z,
  ));
  const tipping = { tip: 0, automaticTipping: true, maximumTip: 45, period: 10, tipSpeed: 30 };
  let appliedTip = 0;
  let elapsed = 0;
  const applyTip = () => {
    vessel.rotation.z = -THREE.MathUtils.degToRad(appliedTip);
    const lowest = Math.min(...corners.map(point => point.x * Math.sin(vessel.rotation.z)
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
  const floorCollider = FluidCollider.Box({ surfaceThickness: 0.015, updatePolicy: 'static' }, 18, 2, 14);
  floorCollider.name = 'Fluid Studio Floor Collider';
  floorCollider.position.set(floor.position.x, floor.position.y - 0.9, floor.position.z);
  root.add(floorCollider);

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
      if (object instanceof FluidCollider && object.geometry) geometries.add(object.geometry);
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
        const smooth = value => THREE.MathUtils.smoothstep(value, 0, 1);
        const amount = phase < 0.45 ? 0 : phase < 0.6 ? smooth((phase - 0.45) / 0.15)
          : phase < 0.7 ? 1 : phase < 0.85 ? 1 - smooth((phase - 0.7) / 0.15) : 0;
        tipping.tip = amount * tipping.maximumTip;
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

createFluidTeapot.author = 'rzmay';
createFluidTeapot.description = 'A lidless Utah teapot filled from above by the FLIP liquid preset.';

createFluidTeapot.metadata = { id: 'fluidTeapot', title: 'Fluid Teapot', author: 'rzmay' };
