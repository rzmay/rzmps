import * as THREE from 'three';
import { ParticleSystem } from '@rzmps/rzmps';

const RING_SIZE = new THREE.Vector3(5, 0, 5);

export default function createSimulationSpace(scene) {
  const root = new THREE.Group();
  root.name = 'World Simulation Space Scene';

  const pixels = new Uint8Array([
    230, 230, 230, 255,
    45, 45, 45, 255,
    45, 45, 45, 255,
    230, 230, 230, 255,
  ]);
  const checkerTexture = new THREE.DataTexture(pixels, 2, 2, THREE.RGBAFormat);
  checkerTexture.wrapS = THREE.RepeatWrapping;
  checkerTexture.wrapT = THREE.RepeatWrapping;
  checkerTexture.repeat.set(20, 20);
  checkerTexture.magFilter = THREE.NearestFilter;
  checkerTexture.needsUpdate = true;

  const floorGeometry = new THREE.PlaneGeometry(40, 40);
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: checkerTexture,
    roughness: 0.9,
  });
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;

  const pathPoints = Array.from({ length: 96 }, (_, index) => {
    const angle = (index / 96) * Math.PI * 2;
    return new THREE.Vector3(
      Math.cos(angle) * RING_SIZE.x,
      0.04,
      Math.sin(angle) * RING_SIZE.z,
    );
  });
  pathPoints.push(pathPoints[0].clone());

  const path = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pathPoints),
    new THREE.LineBasicMaterial({ color: 0x8fd6ff }),
  );

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.48, 32),
    new THREE.MeshBasicMaterial({
      color: 0xfff2a8,
      side: THREE.DoubleSide,
    }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.06;

  const ambient = new THREE.AmbientLight(0xffffff, 0.25);
  const point = new THREE.PointLight(0xffffff, 200);
  point.position.set(10, 20, 0);
  point.castShadow = true;

  root.add(floor, path, marker, ambient, point);
  scene.add(root);

  const originals = new Map();
  let frameId;
  let startTime = performance.now();

  const findActiveParticleSystem = () => {
    let particleSystem;

    scene.traverse((object) => {
      if (object instanceof ParticleSystem && !object.isSubSystem) {
        particleSystem = object;
      }
    });

    return particleSystem;
  };

  const animate = () => {
    const particleSystem = findActiveParticleSystem();

    if (particleSystem) {
      if (!originals.has(particleSystem)) {
        originals.set(particleSystem, {
          simulationSpace: particleSystem.simulationSpace,
          position: particleSystem.position.clone(),
        });

        particleSystem.simulationSpace = 'world';
        startTime = performance.now();
      }

      const time = (performance.now() - startTime) / 1000;
      const x = Math.cos(time * 0.75) * RING_SIZE.x;
      const z = Math.sin(time * 0.75) * RING_SIZE.z;
      const y = particleSystem.position.y;

      particleSystem.position.set(x, y, z);
      marker.position.x = x;
      marker.position.z = z;
    }

    frameId = requestAnimationFrame(animate);
  };

  animate();

  return () => {
    cancelAnimationFrame(frameId);

    originals.forEach((original, particleSystem) => {
      particleSystem.simulationSpace = original.simulationSpace;
      particleSystem.position.copy(original.position);
    });

    scene.remove(root);

    floorGeometry.dispose();
    floorMaterial.dispose();
    checkerTexture.dispose();
    path.geometry.dispose();
    path.material.dispose();
    marker.geometry.dispose();
    marker.material.dispose();
  };
}
