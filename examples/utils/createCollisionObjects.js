import * as THREE from 'three';

export default function createCollisionObjects(includeDynamic = false) {
  const group = new THREE.Group();
  group.name = 'Collision Test';

  const material = new THREE.MeshStandardMaterial({
    color: '#666666',
    roughness: 0.8,
  });

  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 5, 6),
    material,
  );
  wall.position.set(4, 2.5, 0);

  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(6, 4, 0.5),
    material,
  );
  backWall.position.set(0, 2, -4);

  const ramp = new THREE.Mesh(
    new THREE.BoxGeometry(5, 0.4, 4),
    material,
  );
  ramp.position.set(-2, 1, 0);
  ramp.rotation.z = -Math.PI / 8;

  const platform = new THREE.Mesh(
    new THREE.BoxGeometry(3, 0.4, 3),
    material,
  );
  platform.position.set(1.5, 2.5, 1);

  const movingBox = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.5, 1.5),
    new THREE.MeshStandardMaterial({
      color: '#4488ff',
      roughness: 0.6,
    }),
  );
  movingBox.position.set(0, 4, 2);

  let dynamicA;
  let dynamicB;

  if (includeDynamic) {
    dynamicA = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      material,
    );
    dynamicA.position.set(-1.5, 5, 1.5);

    dynamicB = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      material,
    );
    dynamicB.position.set(1, 6, -1);

    dynamicA.castShadow = true;
    dynamicB.receiveShadow = true;

    dynamicA.castShadow = true;
    dynamicB.receiveShadow = true;

    group.add(dynamicA, dynamicB);
  }

  [wall, backWall, ramp, platform, movingBox].forEach((mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  });

  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  const point = new THREE.PointLight(0xffffff, 280);
  point.position.set(10, 20, 0);
  point.castShadow = true;
  group.add(ambient, point);

  return {
    group,
    wall,
    backWall,
    ramp,
    platform,
    movingBox,
    dynamicA,
    dynamicB,
  };
}
