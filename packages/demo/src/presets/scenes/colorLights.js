import * as THREE from 'three';

export default function loadColorLights(scene) {
  const root = new THREE.Group();
  root.name = 'Color Lights Scene';

  // Keep a little ambient light so unlit sides aren't completely black.
  const ambient = new THREE.AmbientLight(0xffffff, 0.15);
  root.add(ambient);

  const lightConfigs = [
    {
      color: 0xff2244,
      intensity: 40,
      radius: 4,
      height: 2.5,
      speed: 0.7,
      phase: 0,
    },
    {
      color: 0x22ff66,
      intensity: 40,
      radius: 5,
      height: 3.5,
      speed: -0.5,
      phase: Math.PI * 0.5,
    },
    {
      color: 0x3388ff,
      intensity: 45,
      radius: 3,
      height: 4.5,
      speed: 0.9,
      phase: Math.PI,
    },
    {
      color: 0xffdd22,
      intensity: 35,
      radius: 6,
      height: 1.5,
      speed: -0.35,
      phase: Math.PI * 1.5,
    },
  ];

  const lights = lightConfigs.map((config) => {
    const light = new THREE.PointLight(
      config.color,
      config.intensity,
      15,
      2,
    );
    light.castShadow = true

    root.add(light);

    // Gizmo showing the light's position + color.
    const helper = new THREE.PointLightHelper(
      light,
      0.25,
    );

    root.add(helper);

    return {
      light,
      helper,
      ...config,
    };
  });

  // Optional ground plane so the moving lighting is also easy to read
  // against something besides particles.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({
      color: 0x303038,
      roughness: 0.8,
      metalness: 0,
    }),
  );

  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  ground.receiveShadow = true;

  root.add(ground);
  scene.add(root);

  let time = 0;

  const update = (deltaTime) => {
    time += deltaTime;

    for (const entry of lights) {
      const angle =
        entry.phase + time * entry.speed;

      entry.light.position.set(
        Math.cos(angle) * entry.radius,
        entry.height + Math.sin(time * entry.speed * 1.7) * 1.5,
        Math.sin(angle) * entry.radius,
      );

      entry.helper.update();
    }
  };

  return {
    update,
    cleanup: () => {
      scene.remove(root);

      ground.geometry.dispose();
      ground.material.dispose();

      for (const { helper } of lights) {
        helper.dispose();
      }
    },
  };
}
