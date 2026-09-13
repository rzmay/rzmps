import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RapierCollisionBackend } from '@rzmps/rapier';
import createCollisionObjects from './createCollisionObjects';

export default async function createRapierCollisionTest(scene) {
  await RAPIER.init();

  const world = new RAPIER.World({
    x: 0,
    y: -9.81,
    z: 0,
  });

  const objects = createCollisionObjects(true);
  scene.add(objects.group);

  const bodies = [];

  const createInitialTransform = (mesh) => ({
    position: mesh.position.clone(),
    rotation: mesh.quaternion.clone(),
  });

  const addBox = (mesh, type = 'fixed') => {
    const params = mesh.geometry.parameters;

    let bodyDesc;

    switch (type) {
      case 'dynamic':
        bodyDesc = RAPIER.RigidBodyDesc.dynamic();
        break;

      case 'kinematic':
        bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
        break;

      default:
        bodyDesc = RAPIER.RigidBodyDesc.fixed();
        break;
    }

    bodyDesc
      .setTranslation(
        mesh.position.x,
        mesh.position.y,
        mesh.position.z,
      )
      .setRotation({
        x: mesh.quaternion.x,
        y: mesh.quaternion.y,
        z: mesh.quaternion.z,
        w: mesh.quaternion.w,
      });

    const body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      params.width / 2,
      params.height / 2,
      params.depth / 2,
    );

    if (type === 'dynamic') {
      colliderDesc.setDensity(1000);
    }

    world.createCollider(colliderDesc, body);

    bodies.push({
      body,
      mesh,
    });

    return body;
  };

  addBox(objects.wall);
  addBox(objects.backWall);
  addBox(objects.ramp);
  addBox(objects.platform);

  const dynamicBodyA =
    addBox(objects.dynamicA, 'dynamic');

  const dynamicBodyB =
    addBox(objects.dynamicB, 'dynamic');

  const dynamicBodies = [
    {
      body: dynamicBodyA,
      mesh: objects.dynamicA,
      initial: createInitialTransform(objects.dynamicA),
    },
    {
      body: dynamicBodyB,
      mesh: objects.dynamicB,
      initial: createInitialTransform(objects.dynamicB),
    },
  ];

  const movingBody =
    addBox(objects.movingBox, 'kinematic');

  // Normally this would be passed into the constructor, but since we don't have particle system access here we have to use scene data
  scene.userData.__rzmps_activeCollisionBackend =
    new RapierCollisionBackend({
      RAPIER,
      world,
    });

  const syncBody = (mesh, body) => {
    const position = body.translation();
    const rotation = body.rotation();

    mesh.position.set(
      position.x,
      position.y,
      position.z,
    );

    mesh.quaternion.set(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );
  };

  const clock = new THREE.Clock();
  const fixedDelta = 1 / 60;
  let accumulator = 0;
  let elapsed = 0;
  let nextRespawn = 10;
  let frameId;

  world.timestep = fixedDelta;

  const animate = () => {
    const frameDelta = Math.min(clock.getDelta(), 0.1);
    accumulator += frameDelta;
    elapsed += frameDelta;

    if (elapsed >= nextRespawn) {
      dynamicBodies.forEach(({ body, initial }) => {
        body.setTranslation(initial.position, true);
        body.setRotation(initial.rotation, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      });

      nextRespawn += 10;
    }

    const x = Math.sin(elapsed) * 2;
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, elapsed * 0.75, 0),
    );

    while (accumulator >= fixedDelta) {
      movingBody.setNextKinematicTranslation({ x, y: 1, z: 2 });
      movingBody.setNextKinematicRotation({
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w,
      });

      world.step();
      accumulator -= fixedDelta;
    }

    syncBody(objects.movingBox, movingBody);
    dynamicBodies.forEach(({ mesh, body }) => {
      syncBody(mesh, body);
    });

    frameId = requestAnimationFrame(animate);
  };

  animate();

  return () => {
    cancelAnimationFrame(frameId);

    delete scene.userData.__rzmps_activeCollisionBackend;

    objects.group.removeFromParent();

    world.free();
  };
}
