/**
 * Signal processing utilities for EEG data.
 * Implements FFT and frequency band power extraction.
 */

/** Radix-2 Cooley-Tukey FFT (in-place, iterative) */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // FFT butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;

      for (let k = 0; k < halfLen; k++) {
        const evenIdx = i + k;
        const oddIdx = i + k + halfLen;

        const tRe = curRe * re[oddIdx] - curIm * im[oddIdx];
        const tIm = curRe * im[oddIdx] + curIm * re[oddIdx];

        re[oddIdx] = re[evenIdx] - tRe;
        im[oddIdx] = im[evenIdx] - tIm;
        re[evenIdx] += tRe;
        im[evenIdx] += tIm;

        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

/** Compute power spectral density from time-domain signal */
export function computePSD(
  samples: Float64Array,
  sampleRate: number
): { frequencies: Float64Array; powers: Float64Array } {
  // Next power of 2
  const n = nextPow2(samples.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Apply Hanning window and copy
  for (let i = 0; i < samples.length; i++) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (samples.length - 1)));
    re[i] = samples[i] * window;
  }

  fft(re, im);

  const halfN = n / 2;
  const frequencies = new Float64Array(halfN);
  const powers = new Float64Array(halfN);
  const freqResolution = sampleRate / n;

  for (let i = 0; i < halfN; i++) {
    frequencies[i] = i * freqResolution;
    powers[i] = (re[i] * re[i] + im[i] * im[i]) / (n * n);
  }

  return { frequencies, powers };
}

export interface BandPowers {
  delta: number;  // 0.5 - 4 Hz
  theta: number;  // 4 - 8 Hz
  alpha: number;  // 8 - 13 Hz
  beta: number;   // 13 - 30 Hz
  gamma: number;  // 30 - 100 Hz
}

/** Extract power in standard EEG frequency bands */
export function extractBandPowers(
  samples: Float64Array,
  sampleRate: number
): BandPowers {
  const { frequencies, powers } = computePSD(samples, sampleRate);

  const bandSum = (low: number, high: number): number => {
    let sum = 0;
    for (let i = 0; i < frequencies.length; i++) {
      if (frequencies[i] >= low && frequencies[i] < high) {
        sum += powers[i];
      }
    }
    return sum;
  };

  return {
    delta: bandSum(0.5, 4),
    theta: bandSum(4, 8),
    alpha: bandSum(8, 13),
    beta: bandSum(13, 30),
    gamma: bandSum(30, 100),
  };
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Rolling buffer for continuous EEG data per channel.
 * Stores the last `size` samples.
 */
export class RollingBuffer {
  private buffer: Float64Array;
  private writeIndex = 0;
  private _count = 0;

  constructor(public readonly size: number) {
    this.buffer = new Float64Array(size);
  }

  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.size;
      if (this._count < this.size) this._count++;
    }
  }

  /** Get ordered array of all stored samples (oldest first) */
  getOrdered(): Float64Array {
    const result = new Float64Array(this._count);
    if (this._count < this.size) {
      // Buffer hasn't wrapped yet
      result.set(this.buffer.subarray(0, this._count));
    } else {
      // Buffer has wrapped — read from writeIndex to end, then start to writeIndex
      const firstPart = this.buffer.subarray(this.writeIndex);
      const secondPart = this.buffer.subarray(0, this.writeIndex);
      result.set(firstPart);
      result.set(secondPart, firstPart.length);
    }
    return result;
  }

  /** Get the last N samples (most recent) */
  getRecent(n: number): Float64Array {
    const count = Math.min(n, this._count);
    const result = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const idx = (this.writeIndex - count + i + this.size) % this.size;
      result[i] = this.buffer[idx];
    }
    return result;
  }

  get count(): number {
    return this._count;
  }

  clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this._count = 0;
  }
}
