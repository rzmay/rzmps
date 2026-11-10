/** Three.js retains WebGPU's 256-byte row padding in texture readback buffers. */
export function packRGBA(pixels, width, height) {
  const rowBytes = width * 4;
  const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const stride = bytes.length === rowBytes * height ? rowBytes : Math.ceil(rowBytes / 256) * 256;
  if (bytes.length < (height - 1) * stride + rowBytes) throw new Error('Incomplete WebGPU texture readback');
  const packed = new Uint8ClampedArray(rowBytes * height);
  for (let row = 0; row < height; row++) {
    packed.set(bytes.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
  }
  return packed;
}

/** Bypass headless canvas swap chains; capture the rendered texture explicitly. */
export async function readTargetPNG(renderer, target, width, height) {
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(packRGBA(pixels, width, height), width, height), 0, 0);
  return canvas.toDataURL('image/png');
}
