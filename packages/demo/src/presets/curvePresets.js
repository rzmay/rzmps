import { Curve, NumberKeyframe } from 'curves';
import { Easing } from 'eaz';

export const curvePresetDefinitions = [
  {
    name: 'fadeOut',
    keyframes: [
      { time: 0, value: 1 },
      { time: 0.7, value: 0.75 },
      { time: 1, value: 0 },
    ],
  },
  {
    name: 'fadeOutLinear',
    keyframes: [
      { time: 0, value: 1, easing: 'linear' },
      { time: 0.7, value: 0.75, easing: 'linear' },
      { time: 1, value: 0, easing: 'linear' },
    ],
  },
  {
    name: 'fadeInOut',
    keyframes: [
      { time: 0, value: 0 },
      { time: 0.2, value: 1 },
      { time: 0.75, value: 0.85 },
      { time: 1, value: 0 },
    ],
  },
  {
    name: 'grow',
    keyframes: [
      { time: 0, value: 0.35, easing: 'linear' },
      { time: 1, value: 1.8, easing: 'linear' },
    ],
  },
  {
    name: 'shrink',
    keyframes: [
      { time: 0, value: 1.3 },
      { time: 1, value: 0.2 },
    ],
  },
];

function createNumberKeyframe({ time, value, easing }) {
  return easing === undefined
    ? new NumberKeyframe(time, value)
    : new NumberKeyframe(time, value, Easing[easing]);
}

export const curvePresets = Object.fromEntries(
  curvePresetDefinitions.map(({ name, keyframes }) => [
    name,
    new Curve(keyframes.map(createNumberKeyframe)),
  ]),
);
