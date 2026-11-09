/** Three's WebGPU readback retains 256-byte row alignment, including partial last rows. */
export function packedPixels(pixels, width, height) {
  const rowBytes = width * 4;
  const source = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const stride = source.length === rowBytes * height ? rowBytes : Math.ceil(rowBytes / 256) * 256;
  if (source.length < (height - 1) * stride + rowBytes) throw new Error('Incomplete WebGPU pixel readback');
  const result = new Uint8ClampedArray(rowBytes * height);
  for (let row = 0; row < height; row++) result.set(source.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
  return result;
}
export async function readTargetPNG(renderer, target, width, height) {
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(packedPixels(pixels, width, height), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}
