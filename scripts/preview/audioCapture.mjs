/** Render Web Audio in simulation time, independent of GPU/encoding wall time. */
export function createAudioCapture({ warmup, deltaTime, duration }, AudioContext = OfflineAudioContext) {
  const sampleRate = 48000;
  const offset = Math.round(warmup * deltaTime * sampleRate);
  const frames = Math.round(duration * sampleRate);
  const context = new AudioContext(2, offset + frames, sampleRate);
  let rendered;
  let time = 0;
  return {
    context,
    async advance(delta) {
      time += delta;
      // Offline suspension is quantized to 128-sample render quanta. Always move
      // forward to avoid duplicate suspension times with fractional video steps.
      const target = (Math.floor((time * sampleRate) / 128) * 128) / sampleRate;
      if (target <= context.currentTime || target >= context.length / sampleRate) return;
      const suspended = context.suspend(target);
      if (!rendered) rendered = context.startRendering();
      else await context.resume();
      await suspended;
    },
    async finish() {
      if (!rendered) rendered = context.startRendering();
      else if (context.state === 'suspended') await context.resume();
      const buffer = await rendered;
      return encodeWAV(buffer, offset, frames);
    },
  };
}

/** Stereo PCM preserves the listener's positional mix; warmup is cropped away. */
export function encodeWAV(buffer, offset, frames) {
  const channels = buffer.numberOfChannels;
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  const word = (at, value) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  word(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  word(8, 'WAVE');
  word(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  word(36, 'data');
  view.setUint32(40, bytes.length - 44, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.max(-1, Math.min(1, data[channel][offset + frame] ?? 0));
      view.setInt16(44 + (frame * channels + channel) * 2, value * (value < 0 ? 32768 : 32767), true);
    }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
