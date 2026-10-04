import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import {
  Boids,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';
import suzanneModel from '../../assets/models/suzanne.glb?url';

function createAffectorMesh(affector, color, opacity = 0.22) {
  const geometry = affector.geometry ?? new THREE.SphereGeometry(0.35, 16, 8);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color).multiplyScalar(0.35),
      transparent: true,
      opacity,
      roughness: 0.5,
      metalness: 0,
      depthWrite: false,
    }),
  );

  mesh.position.copy(affector.position);
  mesh.scale.copy(affector.scale);
  mesh.renderOrder = 2;

  return mesh;
}

function syncMesh(mesh, affector) {
  mesh.position.copy(affector.position);
  mesh.rotation.copy(affector.rotation);
  mesh.scale.copy(affector.scale);
}

function findFirstGeometry(object) {
  let geometry = null;

  object.traverse((child) => {
    if (!geometry && child.isMesh) geometry = child.geometry.clone();
  });

  return geometry;
}

export default async function createBoidAffectors(scene) {
  const gltf = await new GLTFLoader().loadAsync(suzanneModel);
  const suzanneGeometry = findFirstGeometry(gltf.scene);

  if (!suzanneGeometry) {
    throw new Error('suzanne.glb does not contain a mesh');
  }

  suzanneGeometry.rotateX(-Math.PI / 2);

  const root = new THREE.Group();
  root.name = 'Boid Affectors Scene';
  const particleRoot = createSceneParticleRoot(scene, [0, 2, 0]);

  const target = Boids.BoidAffector.Sphere(
    {
      weight: Boids.BoidAffector.Weight.Target * 2.5,
      distance: 1.75,
      tags: 'boid',
    },
    1.25,
    24,
    12,
  );

  target.name = 'Target Boid Affector';
  target.position.set(14, 4, -10);

  const obstacle = Boids.BoidAffector.Sphere(
    {
      weight: Boids.BoidAffector.Weight.Obstacle * 3,
      distance: 2.2,
      tags: 'boid',
    },
    2.4,
    32,
    16,
  );

  obstacle.name = 'Obstacle Boid Affector';
  obstacle.position.set(-12, 3, 8);

  const gate = Boids.BoidAffector.Box(
    {
      weight: Boids.BoidAffector.Weight.Obstacle * 2.4,
      inverted: true,
      distance: 1.8,
      tags: 'boid',
    },
    1.3,
    9.5,
    3.2,
  );

  gate.name = 'Wall Boid Affector';
  gate.position.set(3, 4, 13);
  gate.rotation.y = Math.PI * 0.22;

  const suzanne = new Boids.BoidAffector({
    geometry: suzanneGeometry,
    weight: Boids.BoidAffector.Weight.Obstacle * 3.4,
    distance: 2.4,
    tags: 'boid',
  });

  suzanne.name = 'Suzanne Boid Affector';
  suzanne.position.set(-3, 4.2, -13);
  suzanne.scale.setScalar(2.6);

  const container = Boids.BoidAffector.Box(
    {
      weight: Boids.BoidAffector.Weight.Obstacle * 3.25,
      inverted: true,
      distance: 3.4,
      tags: 'boid',
    },
    52,
    26,
    46,
  );

  container.name = 'Container Boid Affector';
  container.position.set(0, 5.5, 0);

  const targetMesh = createAffectorMesh(target, '#6cff8f', 0.28);
  const obstacleMesh = createAffectorMesh(obstacle, '#ff4c5f', 0.24);
  const gateMesh = createAffectorMesh(gate, '#ffb14c', 0.2);
  const suzanneMesh = createAffectorMesh(suzanne, '#c68cff', 0.3);
  const containerMesh = createAffectorMesh(container, '#66d9ff', 0.05);
  gateMesh.rotation.copy(gate.rotation);

  const targetHelper = new Boids.BoidAffectorHelper(target, 0x6cff8f);
  const obstacleHelper = new Boids.BoidAffectorHelper(obstacle, 0xff4c5f);
  const gateHelper = new Boids.BoidAffectorHelper(gate, 0xffb14c);
  const suzanneHelper = new Boids.BoidAffectorHelper(suzanne, 0xc68cff);
  const containerHelper = new Boids.BoidAffectorHelper(container, 0x66d9ff);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(10, 16, 8);

  root.add(
    target,
    obstacle,
    gate,
    suzanne,
    container,
    targetMesh,
    obstacleMesh,
    gateMesh,
    suzanneMesh,
    containerMesh,
    targetHelper,
    obstacleHelper,
    gateHelper,
    suzanneHelper,
    containerHelper,
    ambient,
    light,
  );

  scene.add(root);

  const updateMeshes = () => {
    syncMesh(targetMesh, target);
    syncMesh(obstacleMesh, obstacle);
    syncMesh(gateMesh, gate);
    syncMesh(suzanneMesh, suzanne);
    syncMesh(containerMesh, container);
    targetHelper.update();
    obstacleHelper.update();
    gateHelper.update();
    suzanneHelper.update();
    containerHelper.update();
  };

  let elapsed = 0;

  return {
    update: (deltaTime) => {
      elapsed += deltaTime;

      target.position.set(
        Math.cos(elapsed * 0.21) * 15,
        4 + Math.sin(elapsed * 0.43) * 1.4,
        Math.sin(elapsed * 0.18) * 11,
      );
      obstacle.position.set(
        Math.cos(elapsed * 0.16 + 2.1) * 14,
        3.5 + Math.sin(elapsed * 0.31) * 1.1,
        Math.sin(elapsed * 0.2 + 1.2) * 12,
      );
      gate.position.set(
        Math.cos(elapsed * 0.13 + 4.2) * 8,
        4.2,
        Math.sin(elapsed * 0.17 + 3) * 15,
      );
      gate.rotation.y = Math.PI * 0.18 + Math.sin(elapsed * 0.22) * 0.65;
      suzanne.position.set(
        Math.cos(elapsed * 0.19 + 5.5) * 16,
        4.5 + Math.sin(elapsed * 0.27 + 1.5) * 1.6,
        Math.sin(elapsed * 0.14 + 4.5) * 13,
      );
      suzanne.rotation.set(
        Math.sin(elapsed * 0.37) * 0.25,
        elapsed * 0.42,
        Math.cos(elapsed * 0.29) * 0.18,
      );

      updateMeshes();
    },

    gui: (folder) => {
      const targetFolder = folder.addFolder('Target');
      targetFolder.add(target.position, 'x', -26, 26, 0.1).name('X').onChange(updateMeshes);
      targetFolder.add(target.position, 'y', -2, 18, 0.1).name('Y').onChange(updateMeshes);
      targetFolder.add(target.position, 'z', -24, 24, 0.1).name('Z').onChange(updateMeshes);
      targetFolder.add(target, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      targetFolder.add(target, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      targetFolder.add(target, 'range', 0, 40, 0.1).name('Range').onChange(updateMeshes);
      targetFolder.add(targetMesh, 'visible').name('Show Mesh');

      const obstacleFolder = folder.addFolder('Obstacle');
      obstacleFolder.add(obstacle.position, 'x', -26, 26, 0.1).name('X').onChange(updateMeshes);
      obstacleFolder.add(obstacle.position, 'y', -2, 18, 0.1).name('Y').onChange(updateMeshes);
      obstacleFolder.add(obstacle.position, 'z', -24, 24, 0.1).name('Z').onChange(updateMeshes);
      obstacleFolder.add(obstacle, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      obstacleFolder.add(obstacle, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      obstacleFolder.add(obstacle, 'range', 0, 40, 0.1).name('Range').onChange(updateMeshes);
      obstacleFolder.add(obstacleMesh, 'visible').name('Show Mesh');

      const wallFolder = folder.addFolder('Wall');
      wallFolder.add(gate.position, 'x', -26, 26, 0.1).name('X').onChange(updateMeshes);
      wallFolder.add(gate.position, 'y', -2, 18, 0.1).name('Y').onChange(updateMeshes);
      wallFolder.add(gate.position, 'z', -24, 24, 0.1).name('Z').onChange(updateMeshes);
      wallFolder.add(gate.rotation, 'y', -Math.PI, Math.PI, 0.01).name('Yaw').onChange(updateMeshes);
      wallFolder.add(gate, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      wallFolder.add(gate, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      wallFolder.add(gate, 'range', 0, 40, 0.1).name('Range').onChange(updateMeshes);
      wallFolder.add(gateMesh, 'visible').name('Show Mesh');

      const suzanneFolder = folder.addFolder('Suzanne');
      suzanneFolder.add(suzanne.position, 'x', -26, 26, 0.1).name('X').onChange(updateMeshes);
      suzanneFolder.add(suzanne.position, 'y', -2, 18, 0.1).name('Y').onChange(updateMeshes);
      suzanneFolder.add(suzanne.position, 'z', -24, 24, 0.1).name('Z').onChange(updateMeshes);
      suzanneFolder.add(suzanne, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      suzanneFolder.add(suzanne, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      suzanneFolder.add(suzanne, 'range', 0, 40, 0.1).name('Range').onChange(updateMeshes);
      suzanneFolder.add(suzanneMesh, 'visible').name('Show Mesh');

      const containerFolder = folder.addFolder('Container');
      containerFolder.add(container.position, 'x', -26, 26, 0.1).name('X').onChange(updateMeshes);
      containerFolder.add(container.position, 'y', -2, 18, 0.1).name('Y').onChange(updateMeshes);
      containerFolder.add(container.position, 'z', -24, 24, 0.1).name('Z').onChange(updateMeshes);
      containerFolder.add(container, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      containerFolder.add(container, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      containerFolder.add(container, 'range', 0, 40, 0.1).name('Range').onChange(updateMeshes);
      containerFolder.add(containerMesh, 'visible').name('Show Mesh');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      targetHelper.dispose();
      obstacleHelper.dispose();
      gateHelper.dispose();
      suzanneHelper.dispose();
      containerHelper.dispose();
      targetMesh.material.dispose();
      obstacleMesh.material.dispose();
      gateMesh.material.dispose();
      suzanneMesh.material.dispose();
      suzanneGeometry.dispose();
      containerMesh.material.dispose();
    },
  };
}

createBoidAffectors.author = "rzmay";
createBoidAffectors.description = "Scene-level BoidAffector targets and obstacles, discovered automatically by the Boids module.";
