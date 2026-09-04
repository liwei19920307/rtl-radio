/** Full FFT bin count (16384). */
export const SPECTRUM_BIN_COUNT = 16384;

/**
 * Decode bins_b64 (f32 LE) into a Float32Array view — one ArrayBuffer alloc per frame.
 * Drops bins_b64 after decode so the string can be GC'd.
 */
export function attachFrameBins(frame) {
  if (!frame || frame._bins) return frame;
  const b64 = frame.bins_b64;
  if (!b64) return frame;

  const count = frame.bin_count || SPECTRUM_BIN_COUNT;
  const byteLen = count * 4;
  const buf = new ArrayBuffer(byteLen);
  const bytes = new Uint8Array(buf);

  if (typeof Uint8Array.fromBase64 === "function") {
    bytes.set(Uint8Array.fromBase64(b64).subarray(0, byteLen));
  } else {
    const bin = atob(b64);
    for (let i = 0; i < byteLen; i++) bytes[i] = bin.charCodeAt(i);
  }

  frame._bins = new Float32Array(buf);
  delete frame.bins_b64;
  return frame;
}

/** Cached Float32Array for the frame, or undefined. */
export function frameBins(frame) {
  return frame?._bins ?? (frame?.bins_b64 ? attachFrameBins(frame)._bins : undefined);
}

/** Linear interpolate a bin value at fractional index (smoother ZOOM / waterfall). */
export function sampleBin(bins, index) {
  if (!bins?.length) return -100;
  const n = bins.length;
  if (index <= 0) return bins[0];
  if (index >= n - 1) return bins[n - 1];
  const i0 = Math.floor(index);
  const f = index - i0;
  return bins[i0] * (1 - f) + bins[i0 + 1] * f;
}
