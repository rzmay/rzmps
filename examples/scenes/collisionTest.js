import * as THREE from 'three';
import createCollisionObjects from '../utils/createCollisionObjects.js';
import {
  createSceneParticleRoot,
  disposeSceneParticleRoot,
} from '../utils/particleRoot.js';

export default async function collisionTestScene(scene) {
  const particleRoot = createSceneParticleRoot(scene, [0, 5, 0]);
  const objects = createCollisionObjects();

  scene.add(objects.group);

  let elapsed = 0;

  const update = (deltaTime) => {
    elapsed += deltaTime;

    objects.movingBox.position.x = Math.sin(elapsed) * 2;
    objects.movingBox.position.y = 1;
    objects.movingBox.rotation.y = elapsed * 0.75;
  };

  return {
    update,
    cleanup: () => {
      disposeSceneParticleRoot(scene, particleRoot);
      objects.group.removeFromParent();

      objects.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;

        object.geometry.dispose();

        if (Array.isArray(object.material)) {
          object.material.forEach((material) => material.dispose());
        }
        else {
          object.material.dispose();
        }
      });
    },
  };
}

collisionTestScene.metadata = {
  'id': 'collisionTest',
  'title': 'Collision (builtin/Octree)',
  'author': 'rzmay'
};
