import Particle from "../Particle";

export default function particleRatio(particle: Particle, ratio: number): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;

  let hash = 0;

  for (let i = 0; i < particle.id.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    hash = (hash * 31 + particle.id.charCodeAt(i)) >>> 0;
  }

  const value = hash / 0xffffffff;
  return value < ratio;
}
