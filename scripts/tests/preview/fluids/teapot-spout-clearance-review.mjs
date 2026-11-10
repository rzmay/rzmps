import fs from 'node:fs/promises';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

const source = await fs.readFile(new URL('../../../../examples/assets/models/utah_teapot_quad.obj',
  import.meta.url), 'utf8');
const model = new OBJLoader().parse(source);
let geometry;
model.traverse(object => { if (object.isMesh) geometry ??= object.geometry; });
const collision = new THREE.BufferGeometry();
collision.setAttribute('position', geometry.getAttribute('position').clone());
const welded = mergeVertices(collision, 1e-4);
const bvh = new MeshBVH(welded, { indirect: true });
const rows = [];
for (const x of [1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25]) {
  let maximum = 0, location;
  for (let y = 0.5; y < 2.8; y += 0.0125) {
    const ray = new THREE.Ray(new THREE.Vector3(x, y, -2), new THREE.Vector3(0, 0, 1));
    const hits = bvh.raycast(ray, THREE.DoubleSide).sort((a, b) => a.distance - b.distance);
    const distances = hits.map(hit => hit.distance)
      .filter((distance, index, values) => index === 0 || distance - values[index - 1] > 1e-5);
    // Interior air intervals between the outermost surfaces of the hollow vessel/spout.
    for (let i = 1; i + 1 < distances.length; i += 2) {
      const z = (distances[i] + distances[i + 1]) * 0.5 - 2;
      const point = new THREE.Vector3(x, y, z);
      const closest = bvh.closestPointToPoint(point);
      if (closest && closest.distance > maximum) { maximum = closest.distance; location = point.toArray(); }
    }
  }
  rows.push({ localX: x, maximumWorldClearance: maximum * 0.76, location });
}
console.log(JSON.stringify({ particleRadius: 0.085 / 2, contactMargin: 0.02,
  requiredWorldClearance: 0.085 / 2 + 0.02, rows }, null, 2));
welded.dispose();
collision.dispose();
geometry.dispose();
