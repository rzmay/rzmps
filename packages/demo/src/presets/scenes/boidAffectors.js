import * as THREE from 'three';
import {
  Boids,
} from '@rzmps/rzmps';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from './particleRoot';

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
  mesh.scale.copy(affector.scale);
}

export default function createBoidAffectors(scene) {
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
  target.position.set(4.2, 2, 0);

  const obstacle = Boids.BoidAffector.Sphere(
    {
      weight: Boids.BoidAffector.Weight.Obstacle * 3,
      distance: 1.6,
      tags: 'boid',
    },
    1.9,
    32,
    16,
  );

  obstacle.name = 'Obstacle Boid Affector';
  obstacle.position.set(-1.2, 2, 0);

  const gate = Boids.BoidAffector.Box(
    {
      weight: Boids.BoidAffector.Weight.Obstacle * 2.4,
      inverted: true,
      distance: 1.2,
      tags: 'boid',
    },
    1.1,
    5.8,
    2.2,
  );

  gate.name = 'Wall Boid Affector';
  gate.position.set(1.4, 2, -2.8);
  gate.rotation.y = Math.PI * 0.12;

  const container = Boids.BoidAffector.Box(
    {
      weight: Boids.BoidAffector.Weight.Obstacle * 3.25,
      inverted: true,
      distance: 2,
      tags: 'boid',
    },
    24,
    18,
    22,
  );

  container.name = 'Container Boid Affector';
  container.position.set(0, 2.5, 0);

  const targetMesh = createAffectorMesh(target, '#6cff8f', 0.28);
  const obstacleMesh = createAffectorMesh(obstacle, '#ff4c5f', 0.24);
  const gateMesh = createAffectorMesh(gate, '#ffb14c', 0.2);
  const containerMesh = createAffectorMesh(container, '#66d9ff', 0.05);
  gateMesh.rotation.copy(gate.rotation);

  const targetHelper = new Boids.BoidAffectorHelper(target, 0x6cff8f);
  const obstacleHelper = new Boids.BoidAffectorHelper(obstacle, 0xff4c5f);
  const gateHelper = new Boids.BoidAffectorHelper(gate, 0xffb14c);
  const containerHelper = new Boids.BoidAffectorHelper(container, 0x66d9ff);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 18),
    new THREE.MeshStandardMaterial({
      color: 0x20252a,
      roughness: 0.88,
      metalness: 0,
    }),
  );

  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(6, 10, 5);

  root.add(
    target,
    obstacle,
    gate,
    container,
    targetMesh,
    obstacleMesh,
    gateMesh,
    containerMesh,
    targetHelper,
    obstacleHelper,
    gateHelper,
    containerHelper,
    ground,
    ambient,
    light,
  );

  scene.add(root);

  const updateMeshes = () => {
    syncMesh(targetMesh, target);
    syncMesh(obstacleMesh, obstacle);
    syncMesh(gateMesh, gate);
    syncMesh(containerMesh, container);
    gateMesh.rotation.copy(gate.rotation);
    targetHelper.update();
    obstacleHelper.update();
    gateHelper.update();
    containerHelper.update();
  };

  return {
    gui: (folder) => {
      const targetFolder = folder.addFolder('Target');
      targetFolder.add(target.position, 'x', -12, 12, 0.1).name('X').onChange(updateMeshes);
      targetFolder.add(target.position, 'y', -2, 10, 0.1).name('Y').onChange(updateMeshes);
      targetFolder.add(target.position, 'z', -12, 12, 0.1).name('Z').onChange(updateMeshes);
      targetFolder.add(target, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      targetFolder.add(target, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      targetFolder.add(targetMesh, 'visible').name('Show Mesh');

      const obstacleFolder = folder.addFolder('Obstacle');
      obstacleFolder.add(obstacle.position, 'x', -12, 12, 0.1).name('X').onChange(updateMeshes);
      obstacleFolder.add(obstacle.position, 'y', -2, 10, 0.1).name('Y').onChange(updateMeshes);
      obstacleFolder.add(obstacle.position, 'z', -12, 12, 0.1).name('Z').onChange(updateMeshes);
      obstacleFolder.add(obstacle, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      obstacleFolder.add(obstacle, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      obstacleFolder.add(obstacleMesh, 'visible').name('Show Mesh');

      const wallFolder = folder.addFolder('Wall');
      wallFolder.add(gate.position, 'x', -12, 12, 0.1).name('X').onChange(updateMeshes);
      wallFolder.add(gate.position, 'y', -2, 10, 0.1).name('Y').onChange(updateMeshes);
      wallFolder.add(gate.position, 'z', -12, 12, 0.1).name('Z').onChange(updateMeshes);
      wallFolder.add(gate.rotation, 'y', -Math.PI, Math.PI, 0.01).name('Yaw').onChange(updateMeshes);
      wallFolder.add(gate, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      wallFolder.add(gate, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      wallFolder.add(gateMesh, 'visible').name('Show Mesh');

      const containerFolder = folder.addFolder('Container');
      containerFolder.add(container.position, 'x', -12, 12, 0.1).name('X').onChange(updateMeshes);
      containerFolder.add(container.position, 'y', -2, 10, 0.1).name('Y').onChange(updateMeshes);
      containerFolder.add(container.position, 'z', -12, 12, 0.1).name('Z').onChange(updateMeshes);
      containerFolder.add(container, 'weight', -10, 10, 0.01).name('Weight').onChange(updateMeshes);
      containerFolder.add(container, 'distance', 0, 8, 0.01).name('Distance').onChange(updateMeshes);
      containerFolder.add(containerMesh, 'visible').name('Show Mesh');
    },

    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      scene.remove(root);

      targetHelper.dispose();
      obstacleHelper.dispose();
      gateHelper.dispose();
      containerHelper.dispose();
      targetMesh.material.dispose();
      obstacleMesh.material.dispose();
      gateMesh.material.dispose();
      containerMesh.material.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
    },
  };
}

createBoidAffectors.author = "rzmay";
createBoidAffectors.description = "Scene-level BoidAffector targets and obstacles, discovered automatically by the Boids module.";
