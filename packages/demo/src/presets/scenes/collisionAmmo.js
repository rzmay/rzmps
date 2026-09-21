import * as THREE from 'three';
import AmmoModule from 'ammo.js/builds/ammo.wasm.js';
import ammoWasmUrl from 'ammo.js/builds/ammo.wasm.wasm?url';
import { AmmoCollisionBackend } from '@rzmps/ammo';
import createCollisionObjects from './createCollisionObjects';

export default async function createAmmoCollisionTest(scene) {
  const scope = {};

  await AmmoModule.call(scope, {
    locateFile: () => ammoWasmUrl,
  });

  const Ammo = scope.Ammo;

  const collisionConfiguration =
    new Ammo.btDefaultCollisionConfiguration();
  const dispatcher =
    new Ammo.btCollisionDispatcher(collisionConfiguration);
  const broadphase =
    new Ammo.btDbvtBroadphase();
  const solver =
    new Ammo.btSequentialImpulseConstraintSolver();
  const world =
    new Ammo.btDiscreteDynamicsWorld(
      dispatcher,
      broadphase,
      solver,
      collisionConfiguration,
    );

  const gravity = new Ammo.btVector3(0, -9.81, 0);
  world.setGravity(gravity);

  const objects = createCollisionObjects(true);
  scene.add(objects.group);

  const bodies = [];
  const scratchTransform = new Ammo.btTransform();

  const createInitialTransform = (mesh) => ({
    position: mesh.position.clone(),
    rotation: mesh.quaternion.clone(),
  });

  const addBox = (mesh, type = 'fixed') => {
    const params = mesh.geometry.parameters;
    const mass = type === 'dynamic' ? 1 : 0;

    const halfExtents = new Ammo.btVector3(
      params.width / 2,
      params.height / 2,
      params.depth / 2,
    );
    const shape = new Ammo.btBoxShape(halfExtents);

    const transform = new Ammo.btTransform();
    const origin = new Ammo.btVector3(
      mesh.position.x,
      mesh.position.y,
      mesh.position.z,
    );
    const rotation = new Ammo.btQuaternion(
      mesh.quaternion.x,
      mesh.quaternion.y,
      mesh.quaternion.z,
      mesh.quaternion.w,
    );

    transform.setIdentity();
    transform.setOrigin(origin);
    transform.setRotation(rotation);

    const localInertia = new Ammo.btVector3(0, 0, 0);
    if (mass > 0) {
      shape.calculateLocalInertia(mass, localInertia);
    }

    const motionState = new Ammo.btDefaultMotionState(transform);
    const bodyInfo = new Ammo.btRigidBodyConstructionInfo(
      mass,
      motionState,
      shape,
      localInertia,
    );

    const body = new Ammo.btRigidBody(bodyInfo);

    if (type === 'kinematic') {
      body.setCollisionFlags(body.getCollisionFlags() | 2);
      body.setActivationState(4);
    }

    world.addRigidBody(body);

    bodies.push({
      body,
      bodyInfo,
      halfExtents,
      initial: createInitialTransform(mesh),
      localInertia,
      mesh,
      motionState,
      origin,
      rotation,
      shape,
      transform,
      type,
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

  const dynamicBodies = bodies.filter((entry) => entry.type === 'dynamic');

  const movingBody =
    addBox(objects.movingBox, 'kinematic');

  const backend =
    new AmmoCollisionBackend({
      Ammo,
      world,
    });

  // Normally this would be passed into the constructor, but since we don't have particle system access here we have to use scene data
  scene.userData.__rzmps_activeCollisionBackend = backend;

  const syncBody = (mesh, body) => {
    const motionState = body.getMotionState();
    if (motionState) {
      motionState.getWorldTransform(scratchTransform);
    } else {
      scratchTransform.setIdentity();
      scratchTransform.setOrigin(body.getCenterOfMassPosition());
      scratchTransform.setRotation(body.getOrientation());
    }

    const position = scratchTransform.getOrigin();
    const rotation = scratchTransform.getRotation();

    mesh.position.set(
      position.x(),
      position.y(),
      position.z(),
    );

    mesh.quaternion.set(
      rotation.x(),
      rotation.y(),
      rotation.z(),
      rotation.w(),
    );
  };

  const setKinematicBody = (body, position, rotation) => {
    const origin = new Ammo.btVector3(
      position.x,
      position.y,
      position.z,
    );
    const orientation = new Ammo.btQuaternion(
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
    );

    scratchTransform.setIdentity();
    scratchTransform.setOrigin(origin);
    scratchTransform.setRotation(orientation);

    body.getMotionState().setWorldTransform(scratchTransform);
    body.setWorldTransform(scratchTransform);

    Ammo.destroy(origin);
    Ammo.destroy(orientation);
  };

  const resetDynamicBody = (entry) => {
    const origin = new Ammo.btVector3(
      entry.initial.position.x,
      entry.initial.position.y,
      entry.initial.position.z,
    );

    const rotation = new Ammo.btQuaternion(
      entry.initial.rotation.x,
      entry.initial.rotation.y,
      entry.initial.rotation.z,
      entry.initial.rotation.w,
    );

    const zero = new Ammo.btVector3(0, 0, 0);

    scratchTransform.setIdentity();
    scratchTransform.setOrigin(origin);
    scratchTransform.setRotation(rotation);

    entry.body.setWorldTransform(scratchTransform);
    entry.body.getMotionState().setWorldTransform(scratchTransform);
    entry.body.setLinearVelocity(zero);
    entry.body.setAngularVelocity(zero);
    entry.body.clearForces();
    entry.body.activate(true);

    Ammo.destroy(origin);
    Ammo.destroy(rotation);
    Ammo.destroy(zero);
  };

  const fixedDelta = 1 / 60;
  let accumulator = 0;
  let elapsed = 0;
  let nextRespawn = 10;

  const update = (deltaTime) => {
    const frameDelta = Math.min(deltaTime, 0.1);
    accumulator += frameDelta;
    elapsed += frameDelta;

    if (elapsed >= nextRespawn) {
      dynamicBodies.forEach(resetDynamicBody);
      nextRespawn += 10;
    }

    const position = new THREE.Vector3(
      Math.sin(elapsed) * 2,
      1,
      2,
    );
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, elapsed * 0.75, 0),
    );

    while (accumulator >= fixedDelta) {
      setKinematicBody(movingBody, position, rotation);
      world.stepSimulation(fixedDelta, 1, fixedDelta);
      accumulator -= fixedDelta;
    }

    syncBody(objects.movingBox, movingBody);
    syncBody(objects.dynamicA, dynamicBodyA);
    syncBody(objects.dynamicB, dynamicBodyB);
  };

  return {
    update,
    cleanup: () => {
      delete scene.userData.__rzmps_activeCollisionBackend;

      objects.group.removeFromParent();

      bodies.forEach((entry) => {
        world.removeRigidBody(entry.body);
        Ammo.destroy(entry.body);
        Ammo.destroy(entry.bodyInfo);
        Ammo.destroy(entry.motionState);
        Ammo.destroy(entry.shape);
        Ammo.destroy(entry.transform);
        Ammo.destroy(entry.origin);
        Ammo.destroy(entry.rotation);
        Ammo.destroy(entry.localInertia);
        Ammo.destroy(entry.halfExtents);
      });

      Ammo.destroy(scratchTransform);
      Ammo.destroy(gravity);
      Ammo.destroy(world);
      Ammo.destroy(solver);
      Ammo.destroy(broadphase);
      Ammo.destroy(dispatcher);
      Ammo.destroy(collisionConfiguration);
    },
  };
}
