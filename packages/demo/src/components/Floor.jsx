/* eslint-disable react/no-unknown-property */
import React, { useEffect, useState, useRef } from 'react';
import PropTypes from 'prop-types';
import * as THREE from 'three';
import checkerboard from '../assets/images/checkerboard.jpg';

function Floor({ width, length, material }) {
  const floorGeometry = new THREE.PlaneGeometry(width ?? 50, length ?? 50, 10, 10);
  const mesh = useRef();
  const [defaultMaterial] = useState(new THREE.MeshPhysicalMaterial({
    roughness: 0.65,
    color: 0x444444,
    side: THREE.DoubleSide,
  }));

  const textureLoader = new THREE.TextureLoader();
  textureLoader.load(checkerboard, (map) => {
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(100, 100);

    defaultMaterial.map = map;
    defaultMaterial.needsUpdate = true;
  });

  useEffect(() => {
    if (mesh !== undefined && mesh.current !== undefined) {
      // @ts-ignore
      mesh.current.position.set(0, 0, 0);

      // @ts-ignore
      mesh.current.rotation.x = Math.PI / 2;
    }
  }, []);

  return (
    <mesh
      ref={mesh}
      geometry={floorGeometry}
      material={material ?? defaultMaterial}
      receiveShadow
    />
  );
}

Floor.propTypes = {
  width: PropTypes.number,
  length: PropTypes.number,
  material: PropTypes.any,
};

export default Floor;
