/**
 * BLINDSIGHT — Session engine.
 *
 * Orchestrates the full session lifecycle:
 *   IDLE → CALIBRATING → WAITING → PAINTING ↔ REVEALING → COMPLETE
 *
 * Wires together: eye detection, brush mapper, brush renderer.
 * Consumes EEG data from the shared monitor-engine.
 */

import { extractBandPowers, type BandPowers } from '../../signal';
import { getChannelBuffers, getIsStreaming } from '../../monitor-engine';
import { EyeDetector } from './eye-detect';
import { BrushMapper } from './mapper';
import { BrushEngine } from './brush';
import { BrainSonifier } from './sonify';
import type {
  BlindState,
  BlindsightCallbacks,
  CalibrationData,
  GestureRecord,
  SessionConfig,
  SessionSummary,
  StrokeFrame,
  SymmetryMode,
  DEFAULT_CONFIG,
} from './types';

const EEG_SAMPLE_RATE = 256;
const FFT_WINDOW = 256;
const CALIBRATION_SECONDS = 15;

export class BlindsightEngine {
  private state: BlindState = 'idle';
  private callbacks: BlindsightCallbacks = {};
  private config: SessionConfig;

  // Sub-systems
  private eyeDetector = new EyeDetector();
  private mapper = new BrushMapper();
  private brushEngine: BrushEngine | null = null;

  // Calibration
  private calibrationStart = 0;
  private calibrationAlphaSamples: number[] = [];
  private calibrationBandSamples: BandPowers[] = [];
  private calibrationTimer: ReturnType<typeof setInterval> | null = null;
  private calibration: CalibrationData | null = null;

  // Session tracking
  private sessionStart = 0;
  private gestures: GestureRecord[] = [];
  private currentGestureStart = 0;
  private currentGestureBands: BandPowers[] = [];
  private totalPaintTime = 0;
  private jawClenchCount = 0;

  // Stroke recording for timelapse replay
  private strokeFrames: StrokeFrame[] = [];

  // Sonification
  private sonifier = new BrainSonifier();

  // Replay
  private replayRaf: number | null = null;

  // Animation
  private overlayInterval: ReturnType<typeof setInterval> | null = null;
  private feedInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<SessionConfig>) {
    this.config = {
      revealMode: 'fade',
      mappingMode: 'fixed',
      roundRobinInterval: 5000,
      smoothingFactor: 0.2,
      fadeDuration: 2.5,
      symmetryMode: 'none',
      soundEnabled: false,
      ...config,
    };
  }

  // ─── Public API ────────────────────────────────────────────────────────

  setCallbacks(cbs: BlindsightCallbacks): void {
    this.callbacks = cbs;
  }

  getState(): BlindState {
    return this.state;
  }

  getCalibration(): CalibrationData | null {
    return this.calibration;
  }

  getGestureCount(): number {
    return this.gestures.length;
  }

  getTotalPaintTime(): number {
    // Include current gesture if painting
    if (this.state === 'painting' && this.currentGestureStart > 0) {
      return this.totalPaintTime + (Date.now() - this.currentGestureStart);
    }
    return this.totalPaintTime;
  }

  getSessionElapsed(): number {
    if (this.sessionStart === 0) return 0;
    return Date.now() - this.sessionStart;
  }

  getGestures(): GestureRecord[] {
    return [...this.gestures];
  }

  getSessionSummary(): SessionSummary {
    const bands: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    for (const g of this.gestures) {
      for (const k of Object.keys(bands) as (keyof BandPowers)[]) {
        bands[k] += g.avgBands[k];
      }
    }
    if (this.gestures.length > 0) {
      for (const k of Object.keys(bands) as (keyof BandPowers)[]) {
        bands[k] /= this.gestures.length;
      }
    }

    let dominant: keyof BandPowers = 'alpha';
    let max = -1;
    for (const k of Object.keys(bands) as (keyof BandPowers)[]) {
      if (bands[k] > max) { max = bands[k]; dominant = k; }
    }

    return {
      totalGestures: this.gestures.length,
      totalPaintTime: this.totalPaintTime,
      gestures: [...this.gestures],
      dominantBand: dominant,
      durationMs: this.getSessionElapsed(),
      jawClenches: this.jawClenchCount,
    };
  }

  /** Attach to canvases and prepare renderer */
  attachCanvas(paintCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement): void {
    this.brushEngine = new BrushEngine(paintCanvas, overlayCanvas);
    this.brushEngine.setFadeDuration(this.config.fadeDuration);
    this.brushEngine.resize();

    const size = this.brushEngine.getLogicalSize();
    this.mapper.setCanvasSize(size.width, size.height);
  }

  resizeCanvas(): void {
    if (!this.brushEngine) return;
    this.brushEngine.resize();
    const size = this.brushEngine.getLogicalSize();
    this.mapper.setCanvasSize(size.width, size.height);
  }

  /** Start calibration (eyes-open baseline collection) */
  startCalibration(): void {
    if (!getIsStreaming()) return;

    this.setState('calibrating');
    this.calibrationStart = Date.now();
    this.calibrationAlphaSamples = [];
    this.calibrationBandSamples = [];

    this.calibrationTimer = setInterval(() => {
      const elapsed = (Date.now() - this.calibrationStart) / 1000;

      // Collect alpha from frontal channels
      const buffers = getChannelBuffers();
      const af7 = buffers[1]; // AF7
      const af8 = buffers[2]; // AF8

      if (af7.count >= FFT_WINDOW && af8.count >= FFT_WINDOW) {
        const af7Samples = af7.getRecent(FFT_WINDOW);
        const af8Samples = af8.getRecent(FFT_WINDOW);
        const af7Bands = extractBandPowers(af7Samples, EEG_SAMPLE_RATE);
        const af8Bands = extractBandPowers(af8Samples, EEG_SAMPLE_RATE);
        const frontalAlpha = (af7Bands.alpha + af8Bands.alpha) / 2;
        this.calibrationAlphaSamples.push(frontalAlpha);

        // Also collect overall band averages
        const avgBands: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        for (const k of Object.keys(avgBands) as (keyof BandPowers)[]) {
          avgBands[k] = (af7Bands[k] + af8Bands[k]) / 2;
        }
        this.calibrationBandSamples.push(avgBands);
      }

      this.callbacks.onCalibrationProgress?.(
        Math.min(elapsed, CALIBRATION_SECONDS),
        CALIBRATION_SECONDS,
      );

      if (elapsed >= CALIBRATION_SECONDS) {
        this.finishCalibration();
      }
    }, 100);
  }

  /** Finish session — export painting and summary */
  finish(): SessionSummary {
    this.stopAnimationLoop();
    this.stopFeedLoop();

    if (this.state === 'painting') {
      this.endCurrentGesture();
    }

    this.brushEngine?.revealInstant();
    const summary = this.getSessionSummary();
    this.setState('complete');
    return summary;
  }

  /** Full reset to idle */
  reset(): void {
    this.stopAnimationLoop();
    this.stopFeedLoop();
    if (this.calibrationTimer) {
      clearInterval(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    this.stopReplay();
    this.state = 'idle';
    this.calibration = null;
    this.eyeDetector.reset();
    this.mapper.reset();
    this.gestures = [];
    this.totalPaintTime = 0;
    this.sessionStart = 0;
    this.jawClenchCount = 0;
    this.strokeFrames = [];
    this.sonifier.stopPainting();
    this.brushEngine?.clearPainting();
    this.brushEngine?.revealInstant();
    this.setState('idle');
  }

  /** Get PNG data URL of the painting */
  exportPNG(): string | null {
    return this.brushEngine?.toDataURL() ?? null;
  }

  /** Access the paint canvas (for gallery saving) */
  getPaintCanvas(): HTMLCanvasElement | null {
    return this.brushEngine?.getPaintCanvas() ?? null;
  }

  /** Get recorded stroke frames (for timelapse replay) */
  getStrokeFrames(): StrokeFrame[] {
    return this.strokeFrames;
  }

  // ─── Symmetry ──────────────────────────────────────────────────────────

  setSymmetryMode(mode: SymmetryMode): void {
    this.config.symmetryMode = mode;
    this.brushEngine?.setSymmetry(mode);
  }

  // ─── Sound ─────────────────────────────────────────────────────────────

  async setSoundEnabled(on: boolean): Promise<void> {
    this.config.soundEnabled = on;
    if (on) {
      await this.sonifier.init();
    }
    this.sonifier.setEnabled(on);
  }

  isSoundEnabled(): boolean {
    return this.config.soundEnabled;
  }

  // ─── Replay ────────────────────────────────────────────────────────────

  /** Replay recorded strokes at accelerated speed. */
  startReplay(speed = 8): void {
    if (!this.brushEngine || this.strokeFrames.length === 0) return;

    this.stopReplay();
    this.brushEngine.clearPainting();
    this.brushEngine.revealInstant(); // show canvas during replay

    const frames = this.strokeFrames;
    let idx = 0;
    const t0 = performance.now();
    const sessionT0 = frames[0].time;
    const sessionDuration = frames[frames.length - 1].time - sessionT0;

    const step = () => {
      const elapsed = (performance.now() - t0) * speed;
      const replayTime = sessionT0 + elapsed;

      // Render all frames up to current replay time
      while (idx < frames.length && frames[idx].time <= replayTime) {
        const f = frames[idx];
        if (f.type === 'stroke') {
          this.brushEngine!.renderStroke(f.brush);
        } else {
          this.brushEngine!.renderStamp(f.brush);
        }
        idx++;
      }

      const progress = Math.min(1, elapsed / sessionDuration);
      this.callbacks.onReplayProgress?.(progress);

      if (idx < frames.length) {
        this.replayRaf = requestAnimationFrame(step);
      } else {
        this.replayRaf = null;
        this.callbacks.onReplayComplete?.();
      }
    };

    this.replayRaf = requestAnimationFrame(step);
  }

  stopReplay(): void {
    if (this.replayRaf !== null) {
      cancelAnimationFrame(this.replayRaf);
      this.replayRaf = null;
    }
  }

  // ─── Calibration ───────────────────────────────────────────────────────

  private finishCalibration(): void {
    if (this.calibrationTimer) {
      clearInterval(this.calibrationTimer);
      this.calibrationTimer = null;
    }

    // Compute baseline alpha
    const alphaArr = this.calibrationAlphaSamples;
    const baselineAlpha = alphaArr.length > 0
      ? alphaArr.reduce((a, b) => a + b, 0) / alphaArr.length
      : 0.001;

    // Compute band baselines
    const bandBaselines: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    for (const s of this.calibrationBandSamples) {
      for (const k of Object.keys(bandBaselines) as (keyof BandPowers)[]) {
        bandBaselines[k] += s[k];
      }
    }
    if (this.calibrationBandSamples.length > 0) {
      for (const k of Object.keys(bandBaselines) as (keyof BandPowers)[]) {
        bandBaselines[k] /= this.calibrationBandSamples.length;
      }
    }

    // Compute per-channel baselines
    const buffers = getChannelBuffers();
    const channelNames = ['TP9', 'AF7', 'AF8', 'TP10'];
    const channelBaselines: CalibrationData['channelBaselines'] = {};
    for (let i = 0; i < 4; i++) {
      const data = buffers[i].getRecent(FFT_WINDOW);
      let sum = 0, sumSq = 0, min = Infinity, max = -Infinity;
      for (let j = 0; j < data.length; j++) {
        sum += data[j];
        sumSq += data[j] * data[j];
        if (data[j] < min) min = data[j];
        if (data[j] > max) max = data[j];
      }
      const meanAmp = sum / Math.max(1, data.length);
      const rms = Math.sqrt(sumSq / Math.max(1, data.length));
      channelBaselines[channelNames[i]] = { meanAmp, rms, min, max };
    }

    this.calibration = {
      baselineAlpha,
      closeThreshold: baselineAlpha * 1.5,
      channelBaselines,
      bandBaselines,
      samples: alphaArr.length,
    };

    // Set up sub-systems
    this.eyeDetector.setBaseline(baselineAlpha);
    this.mapper.setCalibration(this.calibration);
    this.mapper.setSmoothing(this.config.smoothingFactor);
    this.mapper.setMappingMode(this.config.mappingMode, this.config.roundRobinInterval);

    // Apply symmetry mode
    this.brushEngine?.setSymmetry(this.config.symmetryMode);

    // Wire jaw clench: stamp burst on canvas + propagate callback
    this.mapper.setOnJawClench(() => {
      this.jawClenchCount++;
      const stampBrush = this.mapper.getBrush();
      this.brushEngine?.renderStamp(stampBrush);
      // Record stamp frame
      this.strokeFrames.push({ type: 'stamp', brush: { ...stampBrush }, time: Date.now() - this.sessionStart });
      // Sonification percussive hit
      this.sonifier.stamp();
      this.callbacks.onJawClench?.();
    });

    this.sessionStart = Date.now();
    this.brushEngine?.revealInstant(); // Start with canvas visible

    this.startFeedLoop();
    this.startAnimationLoop();

    this.setState('waiting');
  }

  // ─── EEG Processing Loop ──────────────────────────────────────────────

  private startFeedLoop(): void {
    // Run at ~10 Hz (matching FFT update rate)
    this.feedInterval = setInterval(() => this.processTick(), 100);
  }

  private stopFeedLoop(): void {
    if (this.feedInterval) {
      clearInterval(this.feedInterval);
      this.feedInterval = null;
    }
  }

  private processTick(): void {
    if (!getIsStreaming() || !this.calibration) return;

    const buffers = getChannelBuffers();

    // Get frontal alpha for eye detection
    const af7 = buffers[1];
    const af8 = buffers[2];
    if (af7.count < FFT_WINDOW || af8.count < FFT_WINDOW) return;

    const af7Samples = af7.getRecent(FFT_WINDOW);
    const af8Samples = af8.getRecent(FFT_WINDOW);
    const af7Bands = extractBandPowers(af7Samples, EEG_SAMPLE_RATE);
    const af8Bands = extractBandPowers(af8Samples, EEG_SAMPLE_RATE);
    const frontalAlpha = (af7Bands.alpha + af8Bands.alpha) / 2;

    // Eye detection
    const eyeState = this.eyeDetector.feed(frontalAlpha);
    this.callbacks.onEyeStateChange?.(eyeState);

    // State transitions based on eye state
    if (this.state === 'waiting' && eyeState.closed) {
      this.startGesture();
    } else if (this.state === 'painting' && !eyeState.closed) {
      this.endGestureAndReveal();
    } else if (this.state === 'revealing' && this.brushEngine?.isRevealed()) {
      this.setState('waiting');
    }

    // Feed brush mapper during painting
    if (this.state === 'painting') {
      const channelSamples: Float64Array[] = [];
      const perChannel: BandPowers[] = [];

      for (let i = 0; i < 4; i++) {
        channelSamples.push(buffers[i].getRecent(FFT_WINDOW));
        perChannel.push(extractBandPowers(channelSamples[i], EEG_SAMPLE_RATE));
      }

      // Average band powers
      const avgBands: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
      for (const bp of perChannel) {
        for (const k of Object.keys(avgBands) as (keyof BandPowers)[]) {
          avgBands[k] += bp[k] / perChannel.length;
        }
      }

      // Record for gesture summary
      this.currentGestureBands.push({ ...avgBands });

      // Map to brush
      const brush = this.mapper.feed(channelSamples, avgBands, perChannel);
      this.callbacks.onBrushUpdate?.(brush);

      // Render stroke
      this.brushEngine?.renderStroke(brush);

      // Record stroke frame for replay
      this.strokeFrames.push({ type: 'stroke', brush: { ...brush }, time: Date.now() - this.sessionStart });

      // Feed sonifier
      if (this.brushEngine) {
        const size = this.brushEngine.getLogicalSize();
        this.sonifier.feedBrush(brush, size.width, size.height);
      }
    }
  }

  // ─── Gesture Lifecycle ──────────────────────────────────────────────────

  private startGesture(): void {
    this.currentGestureStart = Date.now();
    this.currentGestureBands = [];
    this.brushEngine?.resetStrokePoints();
    this.brushEngine?.hideCanvas(); // Black overlay
    this.sonifier.startPainting();

    this.setState('painting');
    this.callbacks.onGestureStart?.(this.gestures.length + 1);
  }

  private endGestureAndReveal(): void {
    this.endCurrentGesture();
    this.sonifier.stopPainting();

    if (this.config.revealMode === 'fade') {
      this.brushEngine?.startReveal();
      this.setState('revealing');
    } else {
      this.brushEngine?.revealInstant();
      this.setState('waiting');
    }
  }

  private endCurrentGesture(): void {
    const duration = Date.now() - this.currentGestureStart;
    this.totalPaintTime += duration;

    // Compute average bands for this gesture
    const avgBands: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    for (const s of this.currentGestureBands) {
      for (const k of Object.keys(avgBands) as (keyof BandPowers)[]) {
        avgBands[k] += s[k];
      }
    }
    if (this.currentGestureBands.length > 0) {
      for (const k of Object.keys(avgBands) as (keyof BandPowers)[]) {
        avgBands[k] /= this.currentGestureBands.length;
      }
    }

    let dominant: keyof BandPowers = 'alpha';
    let max = -1;
    for (const k of Object.keys(avgBands) as (keyof BandPowers)[]) {
      if (avgBands[k] > max) { max = avgBands[k]; dominant = k; }
    }

    const gesture: GestureRecord = {
      index: this.gestures.length + 1,
      startTime: this.currentGestureStart,
      endTime: Date.now(),
      duration,
      avgBands,
      strokePoints: this.brushEngine?.getStrokePoints() ?? 0,
      dominantBand: dominant,
    };

    this.gestures.push(gesture);
    this.callbacks.onGestureEnd?.(gesture);
  }

  // ─── Animation Loop ─────────────────────────────────────────────────────

  private startAnimationLoop(): void {
    // Use setInterval instead of rAF so reveal animations
    // continue when the browser tab is in the background
    this.overlayInterval = setInterval(() => {
      if (this.brushEngine && this.brushEngine.isFadingOut()) {
        const progress = this.brushEngine.updateOverlay();
        this.callbacks.onRevealProgress?.(progress);
      }
    }, 16); // ~60 fps when foregrounded, throttled to ~1 Hz by browser when backgrounded
  }

  private stopAnimationLoop(): void {
    if (this.overlayInterval !== null) {
      clearInterval(this.overlayInterval);
      this.overlayInterval = null;
    }
  }

  // ─── State ─────────────────────────────────────────────────────────────

  private setState(s: BlindState): void {
    this.state = s;
    this.callbacks.onStateChange?.(s);
  }
}
