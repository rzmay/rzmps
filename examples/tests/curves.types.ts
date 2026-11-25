import { Curve } from 'curves';
import { Color, Vector3 } from 'three';
import { ColorOverLifetime, ScaleOverLifetime, type DynamicValue, type ValueByParameter } from '@rzmps/rzmps';

const alpha: DynamicValue<number> = new Curve({ 0: 0, 0.2: 1, 1: 0 });
const detached: DynamicValue<number> = new Curve({ 0: 0, 1: 1 }).evaluate;
const scale = new Curve({ 0: { x: 1, y: 1, z: 1 }, 1: { x: 2, y: 3, z: 2 } }).cast(
  ({ x, y, z }) => new Vector3(x, y, z),
);
const color = new Curve({ 0: new Color('red'), 1: new Color('blue') }).cast(({ r, g, b }) => new Color(r, g, b));
new ColorOverLifetime({ alpha, color });
new ColorOverLifetime({ alpha: detached });
new ScaleOverLifetime({ scale });
const radialScale: ValueByParameter<Vector3> = scale;
void radialScale;

// @ts-expect-error Structural RGB output is not a Three.js ColorRepresentation without casting.
new ColorOverLifetime({ color: new Curve({ 0: { r: 1, g: 0, b: 0 }, 1: { r: 0, g: 0, b: 1 } }) });
