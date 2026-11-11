/* eslint-disable no-bitwise */
export default function particleRatio(particle: { id: string }, ratio: number): boolean {
  if (ratio <= 0) return false;
  if (ratio >= 1) return true;

  let hash = 0;

  for (let i = 0; i < particle.id.length; i += 1) {
    hash = (hash * 31 + particle.id.charCodeAt(i)) >>> 0;
  }

  // Avalanche structured IDs (gpu:slot:generation) so neighboring slots sample independently.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;

  const value = (hash >>> 0) / 0x100000000;
  return value < ratio;
}
