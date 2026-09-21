import * as THREE from 'three';
import initJolt from '@barclah/jolt-physics';
import { JoltCollisionBackend } from '@rzmps/jolt';
import createCollisionObjects from './createCollisionObjects';

export default async function createJoltCollisionTest(scene) {
  const Jolt = await initJolt();

  const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
  objectFilter.EnableCollision(0, 1);
  objectFilter.EnableCollision(1, 1);

  const nonMoving = new Jolt.BroadPhaseLayer(0);
  const moving = new Jolt.BroadPhaseLayer(1);

  const broadPhaseInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  broadPhaseInterface.MapObjectToBroadPhaseLayer(0, nonMoving);
  broadPhaseInterface.MapObjectToBroadPhaseLayer(1, moving);

  Jolt.destroy(nonMoving);
  Jolt.destroy(moving);

  const objectVsBroadPhaseFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    broadPhaseInterface,
    2,
    objectFilter,
    2,
  );

  const settings = new Jolt.JoltSettings();
  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = broadPhaseInterface;
  settings.mObjectVsBroadPhaseLayerFilter = objectVsBroadPhaseFilter;

  const physicsInterface = new Jolt.JoltInterface(settings);
  Jolt.destroy(settings);

  const physicsSystem = physicsInterface.GetPhysicsSystem();
  const bodyInterface = physicsSystem.GetBodyInterface();

  const syncBody = (mesh, body) => {
    const position =
      bodyInterface.GetPosition(body.GetID());

    const rotation =
      bodyInterface.GetRotation(body.GetID());

    mesh.position.set(
      position.GetX(),
      position.GetY(),
      position.GetZ(),
    );

    mesh.quaternion.set(
      rotation.GetX(),
      rotation.GetY(),
      rotation.GetZ(),
      rotation.GetW(),
    );
  };

  const objects = createCollisionObjects(true);
  scene.add(objects.group);

  const createInitialTransform = (mesh) => ({
    position: mesh.position.clone(),
    rotation: mesh.quaternion.clone(),
  });

  const addBox = (mesh, {
    motion = Jolt.EMotionType_Static,
    layer = 0,
  } = {}) => {
    const p = mesh.geometry.parameters;

    const halfExtents = new Jolt.Vec3(
      p.width / 2,
      p.height / 2,
      p.depth / 2,
    );

    const shape = new Jolt.BoxShape(
      halfExtents,
      0.02,
      null,
    );

    const position = new Jolt.RVec3(
      mesh.position.x,
      mesh.position.y,
      mesh.position.z,
    );

    const rotation = new Jolt.Quat(
      mesh.quaternion.x,
      mesh.quaternion.y,
      mesh.quaternion.z,
      mesh.quaternion.w,
    );

    const bodySettings = new Jolt.BodyCreationSettings(
      shape,
      position,
      rotation,
      motion,
      layer,
    );

    const body = bodyInterface.CreateBody(bodySettings);

    bodyInterface.AddBody(
      body.GetID(),
      Jolt.EActivation_Activate,
    );

    Jolt.destroy(bodySettings);
    Jolt.destroy(position);
    Jolt.destroy(rotation);
    Jolt.destroy(halfExtents);

    return body;
  };

  addBox(objects.wall);
  addBox(objects.backWall);
  addBox(objects.ramp);
  addBox(objects.platform);

  const dynamicA = objects.dynamicA;
  const dynamicB = objects.dynamicB;

  const dynamicBodyA = addBox(dynamicA, {
    motion: Jolt.EMotionType_Dynamic,
    layer: 1,
  });

  const dynamicBodyB = addBox(dynamicB, {
    motion: Jolt.EMotionType_Dynamic,
    layer: 1,
  });

  const dynamicBodies = [
    {
      mesh: dynamicA,
      body: dynamicBodyA,
      initial: createInitialTransform(dynamicA),
    },
    {
      mesh: dynamicB,
      body: dynamicBodyB,
      initial: createInitialTransform(dynamicB),
    },
  ];

  const movingBody = addBox(objects.movingBox, {
    motion: Jolt.EMotionType_Kinematic,
    layer: 1,
  });

  const backend =
    new JoltCollisionBackend({
      Jolt,
      interface: physicsInterface,
      objectLayer: 1,
    });

  // Normally this would be passed into the constructor, but since we don't have particle system access here we have to use scene data
  scene.userData.__rzmps_activeCollisionBackend = backend;

  let elapsed = 0;
  let nextRespawn = 10;

  const update = (deltaTime) => {
    const delta = Math.min(deltaTime, 1 / 30);
    elapsed += delta;

    if (elapsed >= nextRespawn) {
      dynamicBodies.forEach(({ body, initial }) => {
        const position = new Jolt.RVec3(
          initial.position.x,
          initial.position.y,
          initial.position.z,
        );

        const rotation = new Jolt.Quat(
          initial.rotation.x,
          initial.rotation.y,
          initial.rotation.z,
          initial.rotation.w,
        );

        const zero = new Jolt.Vec3(0, 0, 0);
        const id = body.GetID();

        bodyInterface.SetPositionAndRotation(
          id,
          position,
          rotation,
          Jolt.EActivation_Activate,
        );
        bodyInterface.SetLinearVelocity(id, zero);
        bodyInterface.SetAngularVelocity(id, zero);

        Jolt.destroy(position);
        Jolt.destroy(rotation);
        Jolt.destroy(zero);
      });

      nextRespawn += 10;
    }

    const x = Math.sin(elapsed) * 2;
    const rotationY = elapsed * 0.75;

    const targetPosition = new Jolt.RVec3(
      x,
      1,
      2,
    );

    const threeQuaternion =
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          0,
          rotationY,
          0,
        ),
      );

    const targetRotation = new Jolt.Quat(
      threeQuaternion.x,
      threeQuaternion.y,
      threeQuaternion.z,
      threeQuaternion.w,
    );

    bodyInterface.MoveKinematic(
      movingBody.GetID(),
      targetPosition,
      targetRotation,
      delta,
    );

    Jolt.destroy(targetPosition);
    Jolt.destroy(targetRotation);

    physicsInterface.Step(
      delta,
      delta > 1 / 55 ? 2 : 1,
    );

    syncBody(objects.movingBox, movingBody);

    dynamicBodies.forEach(({ mesh, body }) => {
      syncBody(mesh, body);
    });
  };

  return {
    update,
    cleanup: () => {
      delete scene.userData.__rzmps_activeCollisionBackend;

      dynamicBodies.forEach(({ body }) => {
        const id = body.GetID();

        bodyInterface.RemoveBody(id);
        bodyInterface.DestroyBody(id);
      });

      backend.destroy();
      objects.group.removeFromParent();

      Jolt.destroy(physicsInterface);
    },
  };
}
