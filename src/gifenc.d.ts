declare module 'gifenc' {
  type RGB = [number, number, number];
  type RGBA = [number, number, number, number];
  type Palette = RGB[] | RGBA[];

  interface GIFEncoderStream {
    reset(): void;
    bytesView(): Uint8Array;
    bytes(): Uint8Array;
    readonly buffer: ArrayBuffer;
    writeByte(b: number): void;
    writeBytes(data: number[] | Uint8Array, offset?: number, length?: number): void;
  }

  interface WriteFrameOpts {
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    palette?: Palette;
    repeat?: number;
    colorDepth?: number;
    dispose?: number;
    first?: boolean;
  }

  interface GIFEncoderInstance {
    reset(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    readonly buffer: ArrayBuffer;
    readonly stream: GIFEncoderStream;
    writeHeader(): void;
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: WriteFrameOpts,
    ): void;
  }

  interface GIFEncoderOpts {
    initialCapacity?: number;
    auto?: boolean;
  }

  export function GIFEncoder(opts?: GIFEncoderOpts): GIFEncoderInstance;
  export function quantize(
    data: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: 'rgb565' | 'rgb444' | 'rgba4444';
      clearAlpha?: boolean;
      clearAlphaColor?: number;
      clearAlphaThreshold?: number;
      oneBitAlpha?: boolean | number;
      useSqrt?: boolean;
    },
  ): Palette;
  export function applyPalette(
    data: Uint8Array | Uint8ClampedArray,
    palette: Palette,
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
  export function prequantize(
    data: Uint8Array | Uint8ClampedArray,
    options?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void;
  export function nearestColorIndex(palette: Palette, color: RGB | RGBA): number;
  export function snapColorsToPalette(palette: Palette, knownColors: Palette, maxDist?: number): void;

  export default GIFEncoder;
}
