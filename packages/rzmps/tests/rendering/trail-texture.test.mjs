import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { TrailRenderer } from '../../build/index.mjs';

test('trail texture selection honors explicit textures, custom material maps and material options', () => {
  const map = new THREE.Texture(), override = new THREE.Texture();
  const material = new THREE.MeshBasicMaterial({ map });
  const inherited = new TrailRenderer({ material });
  assert.equal(inherited.texture, map);
  const explicit = new TrailRenderer({ material, texture: override });
  assert.equal(explicit.texture, override);
  assert.equal(material.map, override);
  const options = new TrailRenderer({ materialOptions: { map } });
  assert.equal(options.texture, map);
  assert.equal(options.material.map, map);
  inherited.destroy(); explicit.destroy(); options.destroy();
  map.dispose(); override.dispose();
});
