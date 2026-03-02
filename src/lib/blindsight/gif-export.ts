/**
 * BLINDSIGHT — GIF Export.
 *
 * Replays recorded stroke frames onto a scaled-down temp canvas,
 * captures frames at a target FPS, quantizes each frame to 256 colors,
 * and encodes an animated GIF for download.
 *
 * Runs asynchronously, yielding to the browser between frame batches
 * to keep the UI responsive.
 */

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { BrushEngine } from './brush';
import type { StrokeFrame, SymmetryMode } from './types';

// ─── Config ──────────────────────────────────────────────────────────────────

const GIF_WIDTH = 480;
const GIF_FPS = 12;                     // frames per second in the output GIF
const REPLAY_SPEED = 10;                // how fast we replay (10x real-time)
const FRAME_BATCH = 8;                  // encode this many frames before yielding

// ─── Public API ──────────────────────────────────────────────────────────────

export interface GifExportProgress {
  phase: 'replaying' | 'encoding';
  progress: number;   // 0–1
}

/**
 * Generate an animated GIF from recorded stroke frames.
 * Returns a Blob (image/gif) that can be downloaded.
 *
 * @param frames    - recorded StrokeFrame[] from the session
 * @param srcWidth  - logical canvas width during the painting session
 * @param srcHeight - logical canvas height during the painting session
 * @param symmetry  - symmetry mode that was active during the session
 * @param onProgress - progress callback
 */
export async function exportGif(
  frames: StrokeFrame[],
  srcWidth: number,
  srcHeight: number,
  symmetry: SymmetryMode,
  onProgress?: (p: GifExportProgress) => void,
): Promise<Blob> {
  if (frames.length === 0) throw new Error('No frames to export');

  // ─── Setup scaled canvas ──────────────────────────────────────────────

  const aspect = srcWidth / srcHeight;
  const w = GIF_WIDTH;
  const h = Math.round(w / aspect);

  // Off-screen paint canvas + overlay for BrushEngine
  const paintCvs = document.createElement('canvas');
  paintCvs.width = w;
  paintCvs.height = h;
  const overlayCvs = document.createElement('canvas');
  overlayCvs.width = w;
  overlayCvs.height = h;

  // Create a mini BrushEngine that paints at scaled resolution
  const miniEngine = new BrushEngine(paintCvs, overlayCvs);
  miniEngine.setSymmetry(symmetry);

  // Scale factor for brush coords
  const sx = w / srcWidth;
  const sy = h / srcHeight;

  // ─── Determine frame capture times ────────────────────────────────────

  const sessionStart = frames[0].time;
  const sessionEnd = frames[frames.length - 1].time;
  const sessionDuration = sessionEnd - sessionStart;
  const replayDuration = sessionDuration / REPLAY_SPEED;
  const totalGifFrames = Math.ceil(replayDuration / 1000 * GIF_FPS);
  const delayMs = Math.round(1000 / GIF_FPS);             // inter-frame delay in GIF
  const captureInterval = sessionDuration / totalGifFrames; // session-time between captures

  // ─── Replay + Capture frames ──────────────────────────────────────────

  const gif = GIFEncoder();
  const ctx = paintCvs.getContext('2d')!;
  let frameIdx = 0;

  for (let captureN = 0; captureN < totalGifFrames; captureN++) {
    const targetTime = sessionStart + captureN * captureInterval;

    // Advance stroke replay to this time
    while (frameIdx < frames.length && frames[frameIdx].time <= targetTime) {
      const f = frames[frameIdx];
      const scaled = scaleFrame(f, sx, sy);
      if (f.type === 'stroke') {
        miniEngine.renderStroke(scaled);
      } else {
        miniEngine.renderStamp(scaled);
      }
      frameIdx++;
    }

    // Capture this frame
    const imageData = ctx.getImageData(0, 0, w, h);
    const palette = quantize(imageData.data, 256, { format: 'rgb565' });
    const index = applyPalette(imageData.data, palette, 'rgb565');
    gif.writeFrame(index, w, h, {
      palette,
      delay: delayMs,
      dispose: 0,
    });

    // Report progress + yield to browser
    onProgress?.({ phase: 'replaying', progress: (captureN + 1) / totalGifFrames });
    if (captureN % FRAME_BATCH === 0) {
      await yieldToBrowser();
    }
  }

  // ─── Finalize ─────────────────────────────────────────────────────────

  gif.finish();
  const bytes = gif.bytes();
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/gif' });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Scale a StrokeFrame's brush coordinates to the GIF resolution. */
function scaleFrame(f: StrokeFrame, sx: number, sy: number): StrokeFrame['brush'] {
  return {
    ...f.brush,
    x: f.brush.x * sx,
    y: f.brush.y * sy,
    prevX: f.brush.prevX * sx,
    prevY: f.brush.prevY * sy,
    width: Math.max(1, f.brush.width * Math.min(sx, sy)),
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Trigger a file download from a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay to avoid race
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
