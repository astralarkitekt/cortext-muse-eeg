/**
 * NeuroEngine — Audio neurofeedback synthesis engine.
 * Maps real-time EEG band powers to Tone.js audio parameters.
 *
 * Architecture:
 *   1. Drone layer   — sine + triangle oscillators. Alpha controls filter cutoff + gain.
 *                      LFO breathing modulates pitch. Delta shifts base frequency.
 *   2. Pad layer     — PolySynth triangle chords. Theta controls reverb wet + voicing.
 *   3. Sub layer     — Low sine oscillator. Delta controls volume.
 *   4. Texture layer — Brown noise through bandpass. Beta controls filter freq + resonance.
 *   5. Spatial       — Frontal asymmetry (AF7 vs AF8) controls stereo pan.
 *   6. Pluck layer   — Melodic chime notes triggered by EEG band spikes (velocity events).
 *   7. Shimmer layer — Fast arpeggiated crystalline notes driven by gamma.
 *
 * Dynamics:
 *   - Velocity tracking: the rate of change per band triggers discrete events.
 *   - Spike detection: sudden jumps fire pluck notes from a pentatonic scale.
 *   - Gamma arpeggiator: elevated gamma produces shimmering note bursts.
 *   - LFO drift: slow sine modulation keeps the drone alive and breathing.
 *
 * Calibration:
 *   15-second baseline capture. All mappings are relative to the user's baseline.
 *   normalize(x) = clamp((x - mean) / (1.5 * stddev), 0, 1)
 *
 * Smoothing:
 *   Moderate exponential smoothing — fast enough to feel responsive.
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
  delta: { normalized: number; subGain: number; droneFreq: number };
  gamma: { normalized: number; shimmerRate: number };
  asymmetry: { value: number; pan: number };
  spikesThisCycle: number;
}

export interface SpikeEvent {
  band: string;
  velocity: number;
  timestamp: number;  // Date.now()
  elapsed: number;    // seconds since session start
}

export interface TelemetrySnapshot {
  elapsed: number;        // seconds since session start
  timestamp: number;      // Date.now()
  bands: NormalizedBands; // smoothed normalized values at this moment
  dominant: string;
  asymmetry: number;
  energy: number;         // 0-1 audio energy level
}

export interface SessionStats {
  spikeCounts: Record<string, number>; // per-band totals
  spikeLog: SpikeEvent[];              // chronological log
  totalSpikes: number;
  elapsedSeconds: number;
  telemetry: TelemetrySnapshot[];      // 1-per-second snapshots
  calibration: CalibrationData | null;
  sessionDuration: number;             // configured duration (0 = open)
}

export interface NeuroCallbacks {
  onStateChange?: (state: NeuroState) => void;
  onCalibrationProgress?: (elapsed: number, total: number) => void;
  onMappingUpdate?: (mapping: MappingSnapshot, normalized: NormalizedBands, dominant: string) => void;
  onSpikeEvent?: (event: SpikeEvent) => void;
  onSessionTick?: (elapsed: number) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CALIBRATION_SECONDS = 15;
const SMOOTHING_ALPHA = 0.18; // fast response — tracks EEG drift closely
const BAND_KEYS: (keyof BandPowers)[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];

// Spike detection — velocity thresholds for pluck triggering
const SPIKE_VELOCITY_THRESHOLD = 0.095; // lower = more sensitive to small jumps
const SPIKE_COOLDOWN_MS = 240;          // tighter cooldown for more plucks

// Pentatonic scale notes for spike plucks — each band gets a register
const PLUCK_NOTES: Record<string, string[]> = {
  delta: ['C2', 'D2', 'E2', 'G2', 'A2'],
  theta: ['C3', 'D3', 'E3', 'G3', 'A3'],
  alpha: ['C4', 'D4', 'E4', 'G4', 'A4'],
  beta:  ['C5', 'D5', 'E5', 'G5', 'A5'],
  gamma: ['C6', 'D6', 'E6', 'G6', 'A6'],
};

// Shimmer arpeggio notes (high crystalline)
const SHIMMER_NOTES = ['E5', 'G5', 'A5', 'C6', 'D6', 'E6', 'G6', 'A6'];

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

  // Pluck layer (spike-triggered melodic notes)
  private pluckSynth: Tone.PolySynth | null = null;
  private pluckGain: Tone.Gain | null = null;
  private pluckReverb: Tone.Reverb | null = null;

  // Shimmer layer (gamma arpeggiator)
  private shimmerSynth: Tone.PolySynth | null = null;
  private shimmerGain: Tone.Gain | null = null;
  private shimmerDelay: Tone.FeedbackDelay | null = null;
  private shimmerTimer: ReturnType<typeof setInterval> | null = null;
  private shimmerNoteIdx = 0;

  // Drone LFO (pitch breathing)
  private droneLFO: Tone.LFO | null = null;
  private droneLFOGain: Tone.Gain | null = null; // scales LFO depth

  // Velocity tracking (for spike detection)
  private prevNormalized: NormalizedBands = { delta: 0.5, theta: 0.5, alpha: 0.5, beta: 0.5, gamma: 0.5 };
  private lastSpikeTime: Record<string, number> = {};
  private spikesThisCycle = 0;

  // Session tracking
  private sessionStartTime = 0;
  private sessionDuration = 0; // 0 = unlimited
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private spikeCounts: Record<string, number> = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  private spikeLog: SpikeEvent[] = [];
  private telemetryLog: TelemetrySnapshot[] = [];

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

  getSessionStats(): SessionStats {
    const elapsed = this.sessionStartTime > 0
      ? (Date.now() - this.sessionStartTime) / 1000
      : 0;
    return {
      spikeCounts: { ...this.spikeCounts },
      spikeLog: [...this.spikeLog],
      totalSpikes: this.spikeLog.length,
      elapsedSeconds: elapsed,
      telemetry: [...this.telemetryLog],
      calibration: this.calibration ? { ...this.calibration } : null,
      sessionDuration: this.sessionDuration,
    };
  }

  getSessionDuration(): number {
    return this.sessionDuration;
  }

  setSessionDuration(seconds: number): void {
    this.sessionDuration = seconds;
  }

  getSessionElapsed(): number {
    if (this.sessionStartTime === 0) return 0;
    return (Date.now() - this.sessionStartTime) / 1000;
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
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }

    this.setState('idle');
    this.calibration = null;
    this.calibrationSamples = [];
    this.smoothed = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    this.smoothedAsymmetry = 0;
    this.prevNormalized = { delta: 0.5, theta: 0.5, alpha: 0.5, beta: 0.5, gamma: 0.5 };
    this.lastSpikeTime = {};
    this.spikesThisCycle = 0;
    this.shimmerNoteIdx = 0;
    // Note: we keep spikeCounts, spikeLog, and telemetryLog so the UI can show final stats

    // Fade out and stop
    if (this.masterGain) {
      this.masterGain.gain.rampTo(0, 3);
      setTimeout(() => this.stopAudioNodes(), 3200);
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

    // Normalize against baseline (1.2σ — aggressive, magnifies subtle shifts)
    const raw: NormalizedBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    for (const k of BAND_KEYS) {
      const dev = this.calibration.stddev[k] || 0.0001;
      raw[k] = Math.max(0, Math.min(1, (bands[k] - this.calibration.mean[k]) / (1.2 * dev) + 0.5));
    }

    // Exponential smoothing
    for (const k of BAND_KEYS) {
      this.smoothed[k] = this.smoothed[k] * (1 - SMOOTHING_ALPHA) + raw[k] * SMOOTHING_ALPHA;
    }

    // ── Spike / velocity detection ──
    this.spikesThisCycle = 0;
    const now = Date.now();
    const elapsed = this.sessionStartTime > 0 ? (now - this.sessionStartTime) / 1000 : 0;
    for (const k of BAND_KEYS) {
      const velocity = raw[k] - this.prevNormalized[k]; // positive = rising
      const lastSpike = this.lastSpikeTime[k] || 0;
      if (velocity > SPIKE_VELOCITY_THRESHOLD && now - lastSpike > SPIKE_COOLDOWN_MS) {
        this.triggerPluck(k, velocity);
        this.lastSpikeTime[k] = now;
        this.spikesThisCycle++;

        // Record spike event
        this.spikeCounts[k] = (this.spikeCounts[k] || 0) + 1;
        const event: SpikeEvent = { band: k, velocity, timestamp: now, elapsed };
        this.spikeLog.push(event);
        this.callbacks.onSpikeEvent?.(event);
      }
    }
    this.prevNormalized = { ...raw };

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

    // 1. Drone layer — sine + triangle at base frequency, with LFO breathing
    this.droneFilter = new Tone.Filter(400, 'lowpass', -24).connect(this.masterPanner);
    this.droneGain = new Tone.Gain(0.3).connect(this.droneFilter);
    this.droneSine = new Tone.Oscillator(110, 'sine').connect(this.droneGain);
    this.droneTriangle = new Tone.Oscillator(220, 'triangle').connect(this.droneGain);
    this.droneSine.volume.value = -12;
    this.droneTriangle.volume.value = -18;

    // LFO for drone pitch breathing (modulates sine frequency)
    this.droneLFOGain = new Tone.Gain(3).connect(this.droneSine.frequency); // ±3 Hz drift
    this.droneLFO = new Tone.LFO(0.07, -1, 1).connect(this.droneLFOGain); // very slow
    this.droneLFO.type = 'sine';

    // 2. Pad layer — triangle polyphonic synth
    this.padReverb = new Tone.Reverb({ decay: 6, wet: 0.2 }).connect(this.masterPanner);
    this.padGain = new Tone.Gain(0.2).connect(this.padReverb);
    this.padSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 2, decay: 1.5, sustain: 0.7, release: 3 },
    }).connect(this.padGain);
    this.padSynth.volume.value = -20;

    // Chord progression loop
    const chords = [
      ['C3', 'Eb3', 'G3'],
      ['F3', 'Ab3', 'C4'],
      ['Bb2', 'D3', 'F3'],
      ['Eb3', 'G3', 'Bb3'],
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

    // 5. Pluck layer — metallic/bell-like synth for spike events
    this.pluckReverb = new Tone.Reverb({ decay: 3, wet: 0.5 }).connect(this.masterPanner);
    this.pluckGain = new Tone.Gain(0.6).connect(this.pluckReverb);
    this.pluckSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.005, decay: 0.6, sustain: 0, release: 1.2 },
    }).connect(this.pluckGain);
    this.pluckSynth.volume.value = -14;

    // 6. Shimmer layer — crystalline arpeggiator for gamma
    this.shimmerDelay = new Tone.FeedbackDelay('8n', 0.3).connect(this.masterPanner);
    this.shimmerDelay.wet.value = 0.4;
    this.shimmerGain = new Tone.Gain(0).connect(this.shimmerDelay);
    this.shimmerSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sine' },
      envelope: { attack: 0.002, decay: 0.3, sustain: 0, release: 0.8 },
    }).connect(this.shimmerGain);
    this.shimmerSynth.volume.value = -18;

    this.initialized = true;
  }

  private startAudioNodes(): void {
    this.droneSine?.start();
    this.droneTriangle?.start();
    this.droneLFO?.start();
    this.subOsc?.start();
    this.noise?.start();
    this.chordLoop?.start(0);
    Tone.Transport.start();

    // Start shimmer arpeggiator timer (fires notes based on gamma level)
    this.shimmerTimer = setInterval(() => {
      if (this.state !== 'active') return;
      const gamma = this.smoothed.gamma;
      // Only shimmer when gamma is elevated (> 0.35)
      if (gamma < 0.35 || !this.shimmerSynth) return;
      const note = SHIMMER_NOTES[this.shimmerNoteIdx % SHIMMER_NOTES.length];
      this.shimmerNoteIdx++;
      // Velocity proportional to gamma level
      const vel = 0.15 + (gamma - 0.35) * 1.2;
      this.shimmerSynth.triggerAttackRelease(note, '16n', Tone.now(), Math.min(vel, 0.6));
    }, 180); // ~5.5 notes/sec at max

    // Fade in
    this.masterGain?.gain.rampTo(0.8, 3);
  }

  private stopAudioNodes(): void {
    Tone.Transport.stop();
    if (this.shimmerTimer) {
      clearInterval(this.shimmerTimer);
      this.shimmerTimer = null;
    }
    try { this.droneSine?.stop(); } catch { /* ok */ }
    try { this.droneTriangle?.stop(); } catch { /* ok */ }
    try { this.droneLFO?.stop(); } catch { /* ok */ }
    try { this.subOsc?.stop(); } catch { /* ok */ }
    try { this.noise?.stop(); } catch { /* ok */ }
  }

  private disposeAudioNodes(): void {
    const nodes = [
      this.droneSine, this.droneTriangle, this.droneGain, this.droneFilter,
      this.droneLFO, this.droneLFOGain,
      this.padSynth, this.padReverb, this.padGain, this.chordLoop,
      this.subOsc, this.subGain,
      this.noise, this.noiseFilter, this.noiseGain,
      this.pluckSynth, this.pluckGain, this.pluckReverb,
      this.shimmerSynth, this.shimmerGain, this.shimmerDelay,
      this.masterPanner, this.masterGain, this.masterReverb, this.meter,
    ];
    for (const node of nodes) {
      try { node?.dispose(); } catch { /* ok */ }
    }
    this.droneSine = null;
    this.droneTriangle = null;
    this.droneGain = null;
    this.droneFilter = null;
    this.droneLFO = null;
    this.droneLFOGain = null;
    this.padSynth = null;
    this.padReverb = null;
    this.padGain = null;
    this.chordLoop = null;
    this.subOsc = null;
    this.subGain = null;
    this.noise = null;
    this.noiseFilter = null;
    this.noiseGain = null;
    this.pluckSynth = null;
    this.pluckGain = null;
    this.pluckReverb = null;
    this.shimmerSynth = null;
    this.shimmerGain = null;
    this.shimmerDelay = null;
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

    // Reset session tracking
    this.sessionStartTime = Date.now();
    this.spikeCounts = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
    this.spikeLog = [];
    this.telemetryLog = [];

    // Session timer — ticks every second, auto-stops if duration is set
    this.sessionTimer = setInterval(() => {
      const elapsed = (Date.now() - this.sessionStartTime) / 1000;
      this.callbacks.onSessionTick?.(elapsed);

      // Record telemetry snapshot
      this.telemetryLog.push({
        elapsed,
        timestamp: Date.now(),
        bands: { ...this.smoothed },
        dominant: this.getDominantBand(),
        asymmetry: this.smoothedAsymmetry,
        energy: this.getEnergy(),
      });

      if (this.sessionDuration > 0 && elapsed >= this.sessionDuration) {
        this.stop();
      }
    }, 1000);

    this.setState('active');
    this.startAudioNodes();
  }

  // ─── Audio Mapping ─────────────────────────────────────────────────────

  private applyMappings(): void {
    const { alpha, theta, beta, delta, gamma } = this.smoothed;
    const now = Tone.now();
    const tau = 0.2; // tighter audio param tracking

    // Alpha → Drone filter cutoff (200–2400 Hz) + drone gain (0.1–0.55)
    const filterFreq = 200 + alpha * 2200;
    this.droneFilter?.frequency.setTargetAtTime(filterFreq, now, tau);
    const droneGainVal = 0.1 + alpha * 0.45;
    this.droneGain?.gain.setTargetAtTime(droneGainVal, now, tau);

    // Alpha → LFO depth (more alpha = deeper, slower pitch breathing)
    if (this.droneLFOGain) {
      const lfoDepth = 2 + alpha * 8; // 2–10 Hz wobble depth (really audible)
      this.droneLFOGain.gain.setTargetAtTime(lfoDepth, now, tau * 2);
    }
    if (this.droneLFO) {
      const lfoRate = 0.05 + (1 - alpha) * 0.15; // slower when alpha is high
      this.droneLFO.frequency.setTargetAtTime(lfoRate, now, tau * 3);
    }

    // Delta → Drone base pitch (deeper in deep states: 85–110 Hz)
    const droneFreq = 110 - delta * 25;
    this.droneSine?.frequency.setTargetAtTime(droneFreq, now, tau * 4);
    this.droneTriangle?.frequency.setTargetAtTime(droneFreq * 2, now, tau * 4);

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
    const noiseGainVal = beta * 0.35;
    this.noiseGain?.gain.setTargetAtTime(noiseGainVal, now, tau);

    // Delta → Sub bass volume (0–0.4)
    const subGainVal = delta * 0.4;
    this.subGain?.gain.setTargetAtTime(subGainVal, now, tau);

    // Gamma → Shimmer layer gain (0 when low, fades in above 0.3)
    const shimmerGainVal = gamma > 0.3 ? (gamma - 0.3) * 1.0 : 0;
    this.shimmerGain?.gain.setTargetAtTime(shimmerGainVal, now, tau);

    // Asymmetry → Stereo pan (-1 to +1)
    const pan = Math.max(-1, Math.min(1, this.smoothedAsymmetry * 3));
    this.masterPanner?.pan.setTargetAtTime(pan, now, tau * 2);
  }

  /**
   * Fire a melodic pluck note when a band spikes.
   * The band determines the register, velocity determines loudness.
   */
  private triggerPluck(band: string, velocity: number): void {
    if (!this.pluckSynth) return;
    const notes = PLUCK_NOTES[band];
    if (!notes) return;
    const note = notes[Math.floor(Math.random() * notes.length)];
    const vel = Math.min(0.8, 0.25 + velocity * 4);
    this.pluckSynth.triggerAttackRelease(note, '8n', Tone.now(), vel);
  }

  private buildSnapshot(): MappingSnapshot {
    const { alpha, theta, beta, delta, gamma } = this.smoothed;
    const droneFreq = 110 - delta * 25;
    return {
      alpha: {
        normalized: alpha,
        filterFreq: 200 + alpha * 2200,
        droneGain: 0.1 + alpha * 0.45,
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
        droneFreq,
      },
      gamma: {
        normalized: gamma,
        shimmerRate: gamma > 0.4 ? Math.round(1000 / 180) : 0, // notes per second
      },
      asymmetry: {
        value: this.smoothedAsymmetry,
        pan: Math.max(-1, Math.min(1, this.smoothedAsymmetry * 3)),
      },
      spikesThisCycle: this.spikesThisCycle,
    };
  }

  // ─── State Management ──────────────────────────────────────────────────

  private setState(state: NeuroState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}
