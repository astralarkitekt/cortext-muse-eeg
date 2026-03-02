/**
 * BLINDSIGHT — EEG → Brush parameter mapper.
 *
 * POSITION — EOG (electrooculography) eye-movement steering:
 *   AF7 − AF8 differential → X velocity (look left → brush left)
 *   (AF7 + AF8) mean shift  → Y velocity (look down → brush down)
 *   Your eyeballs are joysticks behind closed lids.
 *
 * COLOR:     TP9 theta/beta ratio → Hue (relax = cool, focus = warm)
 * WIDTH:     TP10 peak-to-peak → Brush size
 * OPACITY:   Alpha power → Bold marks in deep relaxation
 * CURVATURE: Theta power → Flowing curves in meditative state
 * TEXTURE:   Beta power → Stipple grain from active thinking
 *
 * JAW CLENCH: TP9 + TP10 simultaneous RMS spike → stamp event callback
 */

import type { BandPowers } from '../../signal';
import type { BrushState, CalibrationData, MappingMode } from './types';

// Mapping constants
const HUE_COOL = 220;    // blue-purple for meditative
const HUE_WARM = 30;     // orange-red for active
const MIN_WIDTH = 2;
const MAX_WIDTH = 40;
const MIN_OPACITY = 0.1;
const MAX_OPACITY = 1.0;

// Channel indices in muse-js order
const CH_TP9 = 0;
const CH_AF7 = 1;
const CH_AF8 = 2;
const CH_TP10 = 3;

// EOG steering — tuned for Muse 2 noise floor
const EOG_VELOCITY_SCALE = 12.0;  // much higher — RMS normalization shrinks the signal
const EOG_SMOOTHING = 0.25;       // heavier smoothing absorbs Muse noise
const EOG_DEAD_ZONE = 0.03;       // low dead zone catches subtle eye movements
const EOG_DRIFT_DECAY = 0.997;    // only applied when gaze is neutral (in dead zone)
const EOG_MEAN_WINDOW = 48;       // wider window averages out noise

// Jaw clench detection
const JAW_CLENCH_MULTIPLIER = 2.5;  // lower threshold for noisy Muse (was 3.5)
const JAW_CLENCH_COOLDOWN = 600;    // faster re-trigger (was 800)

// Round-robin: which color/width/opacity params rotate across channels
const PARAMETER_SLOTS = ['color', 'width'] as const;

export class BrushMapper {
  private calibration: CalibrationData | null = null;
  private smoothingFactor = 0.15;
  private canvasWidth = 800;
  private canvasHeight = 600;

  // Smoothed brush state
  private brush: BrushState = {
    x: 400, y: 300,
    prevX: 400, prevY: 300,
    hue: 220,
    width: 8,
    opacity: 0.5,
    curvature: 0.3,
    texture: 0.2,
  };

  // EOG state
  private smoothedDiffX = 0;   // AF7 − AF8 (horizontal)
  private smoothedMeanY = 0;   // (AF7 + AF8) / 2 shift (vertical)
  private baselineDiffX = 0;   // calibration baseline for horizontal
  private baselineMeanY = 0;   // calibration baseline for vertical

  // Jaw clench state
  private lastClenchTime = 0;
  private jawClenching = false;

  // Round-robin state
  private mappingMode: MappingMode = 'fixed';
  private rotationIndex = 0;
  private lastRotation = 0;
  private roundRobinInterval = 5000;

  // Callback for jaw clench events
  private onJawClench: (() => void) | null = null;

  setCalibration(cal: CalibrationData): void {
    this.calibration = cal;
    // Start brush at canvas center
    this.brush.x = this.canvasWidth / 2;
    this.brush.y = this.canvasHeight / 2;
    this.brush.prevX = this.brush.x;
    this.brush.prevY = this.brush.y;

    // Compute EOG baselines from calibration channel data
    const af7Base = cal.channelBaselines['AF7'];
    const af8Base = cal.channelBaselines['AF8'];
    if (af7Base && af8Base) {
      this.baselineDiffX = af7Base.meanAmp - af8Base.meanAmp;
      this.baselineMeanY = (af7Base.meanAmp + af8Base.meanAmp) / 2;
    }
    this.smoothedDiffX = 0;
    this.smoothedMeanY = 0;
  }

  setCanvasSize(w: number, h: number): void {
    // Scale brush position proportionally
    if (this.canvasWidth > 0 && this.canvasHeight > 0) {
      this.brush.x = (this.brush.x / this.canvasWidth) * w;
      this.brush.y = (this.brush.y / this.canvasHeight) * h;
      this.brush.prevX = (this.brush.prevX / this.canvasWidth) * w;
      this.brush.prevY = (this.brush.prevY / this.canvasHeight) * h;
    }
    this.canvasWidth = w;
    this.canvasHeight = h;
  }

  setSmoothing(factor: number): void {
    this.smoothingFactor = Math.max(0.05, Math.min(0.5, factor));
  }

  setMappingMode(mode: MappingMode, interval = 5000): void {
    this.mappingMode = mode;
    this.roundRobinInterval = interval;
  }

  setOnJawClench(cb: (() => void) | null): void {
    this.onJawClench = cb;
  }

  getBrush(): BrushState {
    return { ...this.brush };
  }

  /**
   * Feed raw channel data and smoothed band powers.
   * channelSamples: recent raw EEG samples per channel (4 channels, each ~256 samples)
   * bandPowers: smoothed band powers (already averaged across channels)
   * perChannel: per-channel band powers array
   */
  feed(
    channelSamples: Float64Array[],
    bandPowers: BandPowers,
    perChannel: BandPowers[],
  ): BrushState {
    if (!this.calibration) return this.brush;

    // Save previous position
    this.brush.prevX = this.brush.x;
    this.brush.prevY = this.brush.y;

    // Handle round-robin rotation (for color/width parameter swapping)
    if (this.mappingMode === 'roundRobin') {
      const now = Date.now();
      if (now - this.lastRotation > this.roundRobinInterval) {
        this.rotationIndex = (this.rotationIndex + 1) % PARAMETER_SLOTS.length;
        this.lastRotation = now;
      }
    }

    const cal = this.calibration;
    const s = this.smoothingFactor;

    // ── EOG-based spatial mapping ──────────────────────────────────────
    // Eye position → brush velocity. Works in both fixed and round-robin modes.

    const af7Raw = channelSamples[CH_AF7];
    const af8Raw = channelSamples[CH_AF8];
    const tp9Raw = channelSamples[CH_TP9];
    const tp10Raw = channelSamples[CH_TP10];

    if (af7Raw.length >= EOG_MEAN_WINDOW && af8Raw.length >= EOG_MEAN_WINDOW) {
      // Use the most recent samples for EOG
      const n = EOG_MEAN_WINDOW;
      const af7Recent = af7Raw.subarray(af7Raw.length - n);
      const af8Recent = af8Raw.subarray(af8Raw.length - n);

      // Compute means of recent window
      let af7Mean = 0, af8Mean = 0;
      for (let i = 0; i < n; i++) {
        af7Mean += af7Recent[i];
        af8Mean += af8Recent[i];
      }
      af7Mean /= n;
      af8Mean /= n;

      // Horizontal: AF7 − AF8 differential (look left → positive, right → negative)
      const rawDiffX = (af7Mean - af8Mean) - this.baselineDiffX;
      // Vertical: (AF7 + AF8)/2 shift from baseline (look up → negative, down → positive)
      const rawMeanY = ((af7Mean + af8Mean) / 2) - this.baselineMeanY;

      // Smooth the signals
      this.smoothedDiffX += EOG_SMOOTHING * (rawDiffX - this.smoothedDiffX);
      this.smoothedMeanY += EOG_SMOOTHING * (rawMeanY - this.smoothedMeanY);

      // Apply dead zone
      const diffX = Math.abs(this.smoothedDiffX) > EOG_DEAD_ZONE ? this.smoothedDiffX : 0;
      const diffY = Math.abs(this.smoothedMeanY) > EOG_DEAD_ZONE ? this.smoothedMeanY : 0;
      const gazeNeutral = diffX === 0 && diffY === 0;

      // Velocity-based: eye direction pushes brush in that direction
      // Normalize by baseline RMS so sensitivity adapts to signal strength
      const af7Rms = cal.channelBaselines['AF7']?.rms ?? 1;
      const scaleX = EOG_VELOCITY_SCALE * (this.canvasWidth / 800);
      const scaleY = EOG_VELOCITY_SCALE * (this.canvasHeight / 600);

      // Look left (positive diff) → brush moves left (negative X)
      this.brush.x -= (diffX / af7Rms) * scaleX;
      // Look down (positive mean shift) → brush moves down (positive Y)
      this.brush.y += (diffY / af7Rms) * scaleY;

      // Only drift toward center when gaze is neutral (not actively steering)
      if (gazeNeutral) {
        const cx = this.canvasWidth / 2;
        const cy = this.canvasHeight / 2;
        this.brush.x = cx + (this.brush.x - cx) * EOG_DRIFT_DECAY;
        this.brush.y = cy + (this.brush.y - cy) * EOG_DRIFT_DECAY;
      }
    }

    // Clamp position
    this.brush.x = Math.max(10, Math.min(this.canvasWidth - 10, this.brush.x));
    this.brush.y = Math.max(10, Math.min(this.canvasHeight - 10, this.brush.y));

    // ── Jaw clench detection: TP9 + TP10 simultaneous spike ────────────
    if (tp9Raw.length >= 12 && tp10Raw.length >= 12) {
      const n = 12;
      const tp9Recent = tp9Raw.subarray(tp9Raw.length - n);
      const tp10Recent = tp10Raw.subarray(tp10Raw.length - n);

      let tp9Rms = 0, tp10Rms = 0;
      for (let i = 0; i < n; i++) {
        tp9Rms += tp9Recent[i] * tp9Recent[i];
        tp10Rms += tp10Recent[i] * tp10Recent[i];
      }
      tp9Rms = Math.sqrt(tp9Rms / n);
      tp10Rms = Math.sqrt(tp10Rms / n);

      const tp9Base = cal.channelBaselines['TP9']?.rms ?? 1;
      const tp10Base = cal.channelBaselines['TP10']?.rms ?? 1;
      const tp9Spike = tp9Rms / tp9Base;
      const tp10Spike = tp10Rms / tp10Base;

      const now = Date.now();
      if (tp9Spike > JAW_CLENCH_MULTIPLIER && tp10Spike > JAW_CLENCH_MULTIPLIER) {
        if (!this.jawClenching && now - this.lastClenchTime > JAW_CLENCH_COOLDOWN) {
          this.jawClenching = true;
          this.lastClenchTime = now;
          this.onJawClench?.();
        }
      } else {
        this.jawClenching = false;
      }
    }

    // ── Hue: TP9 theta/beta ratio → cool (meditative) to warm (active) ──
    let tp9Ratio = 0.5;
    if (perChannel.length > CH_TP9) {
      const tp9 = perChannel[CH_TP9];
      tp9Ratio = tp9.beta > 0.0001 ? tp9.theta / (tp9.theta + tp9.beta) : 0.5;
    }
    const targetHue = HUE_COOL + (1 - tp9Ratio) * (HUE_WARM - HUE_COOL + 360) % 360;
    this.brush.hue = this.smooth(this.brush.hue, targetHue, s * 0.5);

    // ── Width: TP10 peak-to-peak ──
    let tp10P2P = 0;
    if (channelSamples[CH_TP10] && channelSamples[CH_TP10].length >= 12) {
      const recent = channelSamples[CH_TP10].subarray(
        Math.max(0, channelSamples[CH_TP10].length - 12)
      );
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < recent.length; i++) {
        if (recent[i] < min) min = recent[i];
        if (recent[i] > max) max = recent[i];
      }
      tp10P2P = max - min;
    }
    const baseP2P = cal.channelBaselines['TP10']?.rms ?? 1;
    const normP2P = Math.min(1, tp10P2P / (baseP2P * 4));
    const targetWidth = MIN_WIDTH + normP2P * (MAX_WIDTH - MIN_WIDTH);
    this.brush.width = this.smooth(this.brush.width, targetWidth, s);

    // ── Opacity: alpha power ──
    const normAlpha = this.normalizeBand(bandPowers.alpha, cal.bandBaselines.alpha);
    const targetOpacity = MIN_OPACITY + normAlpha * (MAX_OPACITY - MIN_OPACITY);
    this.brush.opacity = this.smooth(this.brush.opacity, targetOpacity, s);

    // ── Curvature: theta power ──
    const normTheta = this.normalizeBand(bandPowers.theta, cal.bandBaselines.theta);
    this.brush.curvature = this.smooth(this.brush.curvature, normTheta, s);

    // ── Texture: beta power ──
    const normBeta = this.normalizeBand(bandPowers.beta, cal.bandBaselines.beta);
    this.brush.texture = this.smooth(this.brush.texture, normBeta, s);

    return { ...this.brush };
  }

  reset(): void {
    this.brush = {
      x: this.canvasWidth / 2,
      y: this.canvasHeight / 2,
      prevX: this.canvasWidth / 2,
      prevY: this.canvasHeight / 2,
      hue: 220,
      width: 8,
      opacity: 0.5,
      curvature: 0.3,
      texture: 0.2,
    };
    this.smoothedDiffX = 0;
    this.smoothedMeanY = 0;
    this.rotationIndex = 0;
    this.lastRotation = 0;
    this.jawClenching = false;
    this.lastClenchTime = 0;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private normalizeBand(current: number, baseline: number): number {
    if (baseline <= 0) return 0.5;
    return Math.max(0, Math.min(1, current / (baseline * 2)));
  }

  private smooth(current: number, target: number, factor: number): number {
    return current + factor * (target - current);
  }
}
