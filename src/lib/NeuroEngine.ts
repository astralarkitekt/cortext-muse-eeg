/**
 * NeuroEngine — Audio neurofeedback synthesis engine.
 * Maps real-time EEG band powers to Tone.js audio parameters.
 *
 * Architecture:
 *   1. Drone layer   — sine + triangle oscillators. Alpha controls filter cutoff + gain.
 *   2. Pad layer     — PolySynth triangle chords. Theta controls reverb wet.
 *   3. Sub layer     — Low sine oscillator. Delta controls volume.
 *   4. Texture layer — Brown noise through bandpass. Beta controls filter freq + resonance.
 *   5. Spatial       — Frontal asymmetry (AF7 vs AF8) controls stereo pan.
 *
 * Calibration:
 *   15-second baseline capture. All mappings are relative to the user's baseline.
 *   normalize(x) = clamp((x - mean) / (2 * stddev), 0, 1)
 *
 * Smoothing:
 *   Heavy exponential smoothing (τ ≈ 0.5s) prevents audio jitter.
 */

import * as Tone from 'tone';
import type { BandPowers } from '../signal';

// ─── Types ───────────────────────────────────────────────────────────────────

export type NeuroState = 'idle' | 'calibrating' | 'active' | 'paused';

export interface CalibrationData {
  mean: BandPowers;
  stddev: BandPowers;
  samples: number;
}

export interface NormalizedBands {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

export interface MappingSnapshot {
  alpha: { normalized: number; filterFreq: number; droneGain: number };
  theta: { normalized: number; reverbWet: number };
  beta:  { normalized: number; noiseFreq: number; noiseQ: number };
  delta: { normalized: number; subGain: number };
  asymmetry: { value: number; pan: number };
}

export interface NeuroCallbacks {
  onStateChange?: (state: NeuroState) => void;
  onCalibrationProgress?: (elapsed: number, total: number) => void;
  onMappingUpdate?: (mapping: MappingSnapshot, normalized: NormalizedBands, dominant: string) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CALIBRATION_SECONDS = 15;
const SMOOTHING_ALPHA = 0.08; // lower = smoother (τ ≈ 0.5s at 100ms update rate)
const BAND_KEYS: (keyof BandPowers)[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];

const DOMINANT_LABELS: Record<string, string> = {
  delta: 'DEEP',
  theta: 'MEDITATIVE',
  alpha: 'RELAXED',
  beta: 'FOCUSED',
  gamma: 'PEAK',
};

// ─── Engine ──────────────────────────────────────────────────────────────────

export default class NeuroEngine {
  private state: NeuroState = 'idle';
  private callbacks: NeuroCallbacks = {};

  // Calibration
  private calibrationStart = 0;
  private calibrationSamples: BandPowers[] = [];
  private calibration: CalibrationData | null = null;
  private calibrationTimer: ReturnType<typeof setInterval> | null = null;

  // Smoothed normalized values
  private smoothed: NormalizedBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  private smoothedAsymmetry = 0;

  // Tone.js nodes
  private initialized = false;

  // Drone layer
  private droneSine: Tone.Oscillator | null = null;
  private droneTriangle: Tone.Oscillator | null = null;
  private droneGain: Tone.Gain | null = null;
  private droneFilter: Tone.Filter | null = null;

  // Pad layer
  private padSynth: Tone.PolySynth | null = null;
  private padReverb: Tone.Reverb | null = null;
  private padGain: Tone.Gain | null = null;
  private chordLoop: Tone.Loop | null = null;

  // Sub layer
  private subOsc: Tone.Oscillator | null = null;
  private subGain: Tone.Gain | null = null;

  // Texture layer
  private noise: Tone.Noise | null = null;
  private noiseFilter: Tone.Filter | null = null;
  private noiseGain: Tone.Gain | null = null;

  // Spatial
  private masterPanner: Tone.Panner | null = null;

  // Master
  private masterGain: Tone.Gain | null = null;
  private masterReverb: Tone.Reverb | null = null;
  private meter: Tone.Meter | null = null;

  // ─── Public API ────────────────────────────────────────────────────────

  setCallbacks(cbs: NeuroCallbacks) {
    this.callbacks = cbs;
  }

  getState(): NeuroState {
    return this.state;
  }

  getCalibration(): CalibrationData | null {
    return this.calibration;
  }

  getDominantBand(): string {
    let max = -Infinity;
    let dom = 'alpha';
    for (const k of BAND_KEYS) {
      if (this.smoothed[k] > max) {
        max = this.smoothed[k];
        dom = k;
      }
    }
    return dom;
  }

  getDominantLabel(): string {
    return DOMINANT_LABELS[this.getDominantBand()] || 'IDLE';
  }

  getNormalized(): NormalizedBands {
    return { ...this.smoothed };
  }

  getEnergy(): number {
    if (!this.meter) return 0;
    const level = this.meter.getValue();
    const db = typeof level === 'number' ? level : level[0];
    return Math.max(0, (db + 60) / 60);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.initialized) {
      await this.initAudio();
    }

    this.setState('calibrating');
    this.calibrationStart = Date.now();
    this.calibrationSamples = [];

    // Progress ticker
    this.calibrationTimer = setInterval(() => {
      const elapsed = (Date.now() - this.calibrationStart) / 1000;
      this.callbacks.onCalibrationProgress?.(
        Math.min(elapsed, CALIBRATION_SECONDS),
        CALIBRATION_SECONDS
      );

      if (elapsed >= CALIBRATION_SECONDS) {
        this.finishCalibration();
      }
    }, 100);
  }

  pause(): void {
    if (this.state !== 'active') return;
    this.setState('paused');
    this.masterGain?.gain.rampTo(0, 0.5);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('active');
    this.masterGain?.gain.rampTo(0.8, 0.5);
  }

  stop(): void {
    if (this.calibrationTimer) {
      clearInterval(this.calibrationTimer);
      this.calibrationTimer = null;
    }

    this.setState('idle');
    this.calibration = null;
    this.calibrationSamples = [];
    this.smoothed = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    this.smoothedAsymmetry = 0;

    // Fade out and stop
    if (this.masterGain) {
      this.masterGain.gain.rampTo(0, 1);
      setTimeout(() => this.stopAudioNodes(), 1100);
    }
  }

  dispose(): void {
    this.stop();
    setTimeout(() => {
      this.disposeAudioNodes();
      this.initialized = false;
    }, 1200);
  }

  setMasterVolume(db: number): void {
    this.masterGain?.gain.rampTo(Tone.dbToGain(db), 0.1);
  }

  // ─── EEG Feed ──────────────────────────────────────────────────────────

  /**
   * Called on every band power update from the monitor engine.
   * @param bands Smoothed band powers (raw, not normalized)
   * @param perChannel Per-channel band powers (for asymmetry)
   */
  feedBands(bands: BandPowers, perChannel: BandPowers[]): void {
    if (this.state === 'calibrating') {
      this.calibrationSamples.push({ ...bands });
      return;
    }

    if (this.state !== 'active') return;
    if (!this.calibration) return;

    // Normalize against baseline
    const raw: NormalizedBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    for (const k of BAND_KEYS) {
      const dev = this.calibration.stddev[k] || 0.0001;
      raw[k] = Math.max(0, Math.min(1, (bands[k] - this.calibration.mean[k]) / (2 * dev) + 0.5));
    }

    // Exponential smoothing
    for (const k of BAND_KEYS) {
      this.smoothed[k] = this.smoothed[k] * (1 - SMOOTHING_ALPHA) + raw[k] * SMOOTHING_ALPHA;
    }

    // Frontal asymmetry (AF7 = index 1, AF8 = index 2)
    if (perChannel.length >= 3) {
      const af7Alpha = perChannel[1]?.alpha ?? 0;
      const af8Alpha = perChannel[2]?.alpha ?? 0;
      const total = af7Alpha + af8Alpha;
      const asymmetry = total > 0 ? (af8Alpha - af7Alpha) / total : 0; // -1 to +1
      this.smoothedAsymmetry = this.smoothedAsymmetry * 0.95 + asymmetry * 0.05;
    }

    // Apply to audio
    this.applyMappings();

    // Notify UI
    const dominant = this.getDominantBand();
    this.callbacks.onMappingUpdate?.(this.buildSnapshot(), { ...this.smoothed }, dominant);
  }

  // ─── Audio Init ────────────────────────────────────────────────────────

  private async initAudio(): Promise<void> {
    await Tone.start();
    Tone.Transport.bpm.value = 60;

    // Master chain: panner → gain → reverb → meter → destination
    this.meter = new Tone.Meter();
    this.masterReverb = new Tone.Reverb({ decay: 4, wet: 0.3 }).toDestination();
    this.masterReverb.connect(this.meter);
    this.masterGain = new Tone.Gain(0).connect(this.masterReverb);
    this.masterPanner = new Tone.Panner(0).connect(this.masterGain);

    // 1. Drone layer — sine + triangle at base frequency
    this.droneFilter = new Tone.Filter(400, 'lowpass', -24).connect(this.masterPanner);
    this.droneGain = new Tone.Gain(0.3).connect(this.droneFilter);
    this.droneSine = new Tone.Oscillator(110, 'sine').connect(this.droneGain);
    this.droneTriangle = new Tone.Oscillator(220, 'triangle').connect(this.droneGain);
    this.droneSine.volume.value = -12;
    this.droneTriangle.volume.value = -18;

    // 2. Pad layer — triangle polyphonic synth
    this.padReverb = new Tone.Reverb({ decay: 6, wet: 0.2 }).connect(this.masterPanner);
    this.padGain = new Tone.Gain(0.2).connect(this.padReverb);
    this.padSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 2, decay: 1.5, sustain: 0.7, release: 3 },
    }).connect(this.padGain);
    this.padSynth.volume.value = -20;

    // Chord progression loop (I → IV in C minor for a contemplative feel)
    const chords = [
      ['C3', 'Eb3', 'G3'],   // Cm
      ['F3', 'Ab3', 'C4'],   // Fm
      ['Bb2', 'D3', 'F3'],   // Bb
      ['Eb3', 'G3', 'Bb3'],  // Eb
    ];
    let chordIdx = 0;
    this.chordLoop = new Tone.Loop((time: number) => {
      const chord = chords[chordIdx % chords.length];
      this.padSynth?.triggerAttackRelease(chord, '3m', time, 0.3);
      chordIdx++;
    }, '4m');

    // 3. Sub bass layer — deep sine
    this.subGain = new Tone.Gain(0).connect(this.masterPanner);
    this.subOsc = new Tone.Oscillator(55, 'sine').connect(this.subGain);
    this.subOsc.volume.value = -8;

    // 4. Texture layer — brown noise through bandpass
    this.noiseFilter = new Tone.Filter(800, 'bandpass').connect(this.masterPanner);
    this.noiseFilter.Q.value = 2;
    this.noiseGain = new Tone.Gain(0).connect(this.noiseFilter);
    this.noise = new Tone.Noise('brown').connect(this.noiseGain);
    this.noise.volume.value = -24;

    this.initialized = true;
  }

  private startAudioNodes(): void {
    this.droneSine?.start();
    this.droneTriangle?.start();
    this.subOsc?.start();
    this.noise?.start();
    this.chordLoop?.start(0);
    Tone.Transport.start();

    // Fade in
    this.masterGain?.gain.rampTo(0.8, 3);
  }

  private stopAudioNodes(): void {
    Tone.Transport.stop();
    try { this.droneSine?.stop(); } catch { /* ok */ }
    try { this.droneTriangle?.stop(); } catch { /* ok */ }
    try { this.subOsc?.stop(); } catch { /* ok */ }
    try { this.noise?.stop(); } catch { /* ok */ }
  }

  private disposeAudioNodes(): void {
    const nodes = [
      this.droneSine, this.droneTriangle, this.droneGain, this.droneFilter,
      this.padSynth, this.padReverb, this.padGain, this.chordLoop,
      this.subOsc, this.subGain,
      this.noise, this.noiseFilter, this.noiseGain,
      this.masterPanner, this.masterGain, this.masterReverb, this.meter,
    ];
    for (const node of nodes) {
      try { node?.dispose(); } catch { /* ok */ }
    }
    this.droneSine = null;
    this.droneTriangle = null;
    this.droneGain = null;
    this.droneFilter = null;
    this.padSynth = null;
    this.padReverb = null;
    this.padGain = null;
    this.chordLoop = null;
    this.subOsc = null;
    this.subGain = null;
    this.noise = null;
    this.noiseFilter = null;
    this.noiseGain = null;
    this.masterPanner = null;
    this.masterGain = null;
    this.masterReverb = null;
    this.meter = null;
  }

  // ─── Calibration ──────────────────────────────────────────────────────

  private finishCalibration(): void {
    if (this.calibrationTimer) {
      clearInterval(this.calibrationTimer);
      this.calibrationTimer = null;
    }

    const samples = this.calibrationSamples;
    if (samples.length === 0) {
      // No data — use sensible defaults
      this.calibration = {
        mean: { delta: 0.001, theta: 0.001, alpha: 0.001, beta: 0.001, gamma: 0.001 },
        stddev: { delta: 0.001, theta: 0.001, alpha: 0.001, beta: 0.001, gamma: 0.001 },
        samples: 0,
      };
    } else {
      const mean: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
      for (const s of samples) {
        for (const k of BAND_KEYS) mean[k] += s[k] / samples.length;
      }

      const stddev: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
      for (const s of samples) {
        for (const k of BAND_KEYS) stddev[k] += (s[k] - mean[k]) ** 2 / samples.length;
      }
      for (const k of BAND_KEYS) stddev[k] = Math.sqrt(stddev[k]) || 0.0001;

      this.calibration = { mean, stddev, samples: samples.length };
    }

    // Initialize smoothed to 0.5 (neutral)
    this.smoothed = { delta: 0.5, theta: 0.5, alpha: 0.5, beta: 0.5, gamma: 0.5 };

    this.setState('active');
    this.startAudioNodes();
  }

  // ─── Audio Mapping ─────────────────────────────────────────────────────

  private applyMappings(): void {
    const { alpha, theta, beta, delta } = this.smoothed;
    const now = Tone.now();
    const tau = 0.3; // audio param smoothing time constant

    // Alpha → Drone filter cutoff (200–2200 Hz) + drone gain (0.1–0.5)
    const filterFreq = 200 + alpha * 2000;
    this.droneFilter?.frequency.setTargetAtTime(filterFreq, now, tau);
    const droneGainVal = 0.1 + alpha * 0.4;
    this.droneGain?.gain.setTargetAtTime(droneGainVal, now, tau);

    // Theta → Reverb wet (0.1–0.8) on the pad layer
    const reverbWet = 0.1 + theta * 0.7;
    if (this.padReverb) {
      this.padReverb.wet.setTargetAtTime(reverbWet, now, tau * 2);
    }

    // Beta → Noise filter frequency (200–3000 Hz) + Q (1–12)
    const noiseFreq = 200 + beta * 2800;
    const noiseQ = 1 + beta * 11;
    this.noiseFilter?.frequency.setTargetAtTime(noiseFreq, now, tau);
    this.noiseFilter?.Q.setTargetAtTime(noiseQ, now, tau);
    // Beta also controls noise volume (louder = more active thinking texture)
    const noiseGainVal = beta * 0.35;
    this.noiseGain?.gain.setTargetAtTime(noiseGainVal, now, tau);

    // Delta → Sub bass volume (0–0.4)
    const subGainVal = delta * 0.4;
    this.subGain?.gain.setTargetAtTime(subGainVal, now, tau);

    // Asymmetry → Stereo pan (-1 to +1)
    const pan = Math.max(-1, Math.min(1, this.smoothedAsymmetry * 3));
    this.masterPanner?.pan.setTargetAtTime(pan, now, tau * 2);
  }

  private buildSnapshot(): MappingSnapshot {
    const { alpha, theta, beta, delta } = this.smoothed;
    return {
      alpha: {
        normalized: alpha,
        filterFreq: 200 + alpha * 2000,
        droneGain: 0.1 + alpha * 0.4,
      },
      theta: {
        normalized: theta,
        reverbWet: 0.1 + theta * 0.7,
      },
      beta: {
        normalized: beta,
        noiseFreq: 200 + beta * 2800,
        noiseQ: 1 + beta * 11,
      },
      delta: {
        normalized: delta,
        subGain: delta * 0.4,
      },
      asymmetry: {
        value: this.smoothedAsymmetry,
        pan: Math.max(-1, Math.min(1, this.smoothedAsymmetry * 3)),
      },
    };
  }

  // ─── State Management ──────────────────────────────────────────────────

  private setState(state: NeuroState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}
