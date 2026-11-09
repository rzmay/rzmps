import type { ColorRepresentation, Vector3 } from 'three';

/** A Three.js color or any value accepted by its constructor. */
export type ColorInput = ColorRepresentation;

/** A vector or a uniform value applied to all three axes. */
export type Vector3Input = Vector3 | number;
