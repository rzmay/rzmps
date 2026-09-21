/* eslint-disable react/no-unknown-property */
import React, { useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { useFrame, extend, useThree } from '@react-three/fiber';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import * as THREE from 'three';

extend({ OrbitControls });

function CameraControls({ fov, zoomSpeed, rotationSpeed }) {
  // Get a reference to the Three.js Camera, and the canvas html element.
  // We need these to setup the OrbitControls class.
  // https://threejs.org/docs/#examples/en/controls/OrbitControls

  const {
    scene,
    camera,
    gl: { domElement },
  } = useThree();

  // Ref to the controls, so that we can update them on every frame using useFrame
  const controls = useRef();

  useEffect(() => {
    // FOV
    if (camera instanceof THREE.PerspectiveCamera) camera.fov = fov ?? 45;
    // Position camera
    camera.position.set(0, 5, 10);
    camera.lookAt(scene.position);
  }, [camera, fov, scene]);

  useFrame(() => controls.current.update());

  return (
    <orbitControls
      ref={controls}
      args={[camera, domElement]}
      zoomSpeed={zoomSpeed ?? 0.75}
      rotateSpeed={rotationSpeed ?? 0.25}
    />
  );
}

CameraControls.propTypes = {
  fov: PropTypes.number,
  zoomSpeed: PropTypes.number,
  rotationSpeed: PropTypes.number,
};

export default CameraControls;
