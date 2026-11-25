import { Curve } from 'curves';
import { Easing } from 'eaz';

/** Preserve the ordinary numeric timestamp curves used by presets when exporting demo code. */
export function serializeCurve(value) {
  if (!(value instanceof Curve) || value.source || value.modifiers.length) return undefined;
  if (
    !value.keys.every(
      key => typeof key.value === 'number' && key.inEasing === Easing.cubic && key.outEasing === Easing.cubic,
    )
  )
    return undefined;
  const entries = value.keys.map(
    key => `${key.time < 0 ? JSON.stringify(String(key.time)) : key.time}: ${JSON.stringify(key.value)}`,
  );
  if (value.endBehaviour !== 0) entries.push(`endBehavior: ${value.endBehaviour}`);
  if (value.smoothing !== 0.25) entries.push(`smoothing: ${value.smoothing}`);
  return `new Curve({ ${entries.join(', ')} })`;
}
