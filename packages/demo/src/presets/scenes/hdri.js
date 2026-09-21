import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export default function loadHdri(url) {
  return (scene) => {
    let disposed = false;
    let environmentTexture = null;

    const ambient = new THREE.AmbientLight(0xffffff, 0.18);
    const point = new THREE.PointLight(0xffffff, 1);
    point.position.set(10, 20, 0);
    scene.add(ambient, point);

    new HDRLoader().load(url, (texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }

      texture.mapping = THREE.EquirectangularReflectionMapping;
      environmentTexture = texture;
      scene.environment = texture;
      scene.background = texture;
    });

    return () => {
      disposed = true;
      scene.remove(ambient, point);

      if (environmentTexture) environmentTexture.dispose();

      scene.environment = null;
    };
  }
}
