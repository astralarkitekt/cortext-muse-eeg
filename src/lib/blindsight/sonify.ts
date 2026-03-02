/**
 * BLINDSIGHT — Brain sonification engine.
 *
 * Maps brush state to ambient synth parameters in real-time,
 * creating a multisensory painting experience.
 *
 *   X position  → stereo pan
 *   Y position  → pitch (low at bottom, high at top)
 *   Hue         → harmonicity / timbre
 *   Width       → filter cutoff
 *   Opacity     → volume
 *   Jaw clench  → percussive membrane hit
 */

import * as Tone from 'tone';
import type { BrushState } from './types';

export class BrainSonifier {
  private synth: Tone.FMSynth | null = null;
  private pad: Tone.AMSynth | null = null;
  private perc: Tone.MembraneSynth | null = null;
  private panner: Tone.Panner | null = null;
  private filter: Tone.Filter | null = null;
  private reverb: Tone.Reverb | null = null;
  private delay: Tone.FeedbackDelay | null = null;

  private isPlaying = false;
  private enabled = false;
  private initialized = false;

  /** Must be called from a user-gesture handler (click) */
  async init(): Promise<void> {
    if (this.initialized) return;

    await Tone.start();

    // Signal chain: synth → filter → panner → delay → reverb → destination
    this.reverb = new Tone.Reverb({ decay: 5, wet: 0.45 }).toDestination();
    this.delay = new Tone.FeedbackDelay({
      delayTime: '8n',
      feedback: 0.2,
      wet: 0.25,
    }).connect(this.reverb);
    this.panner = new Tone.Panner(0).connect(this.delay);
    this.filter = new Tone.Filter({
      frequency: 600,
      type: 'lowpass',
      rolloff: -24,
      Q: 1.5,
    }).connect(this.panner);

    // Primary drone synth — FM for rich harmonics
    this.synth = new Tone.FMSynth({
      harmonicity: 3,
      modulationIndex: 2,
      oscillator: { type: 'sine' },
      modulation: { type: 'triangle' },
      envelope: { attack: 1.2, decay: 0.3, sustain: 0.7, release: 2.5 },
      modulationEnvelope: { attack: 0.8, decay: 0, sustain: 1, release: 1.0 },
      volume: -30,
    }).connect(this.filter);

    // Soft pad layer for depth
    this.pad = new Tone.AMSynth({
      harmonicity: 2,
      oscillator: { type: 'triangle' },
      modulation: { type: 'sine' },
      envelope: { attack: 2.0, decay: 0.5, sustain: 0.6, release: 3.0 },
      modulationEnvelope: { attack: 1.5, decay: 0, sustain: 1, release: 2.0 },
      volume: -36,
    }).connect(this.filter);

    // Percussive hit for jaw clench stamps
    this.perc = new Tone.MembraneSynth({
      pitchDecay: 0.08,
      octaves: 5,
      envelope: { attack: 0.001, decay: 0.5, sustain: 0, release: 0.5 },
      volume: -16,
    }).connect(this.reverb);

    this.initialized = true;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on && this.isPlaying) this.stopPainting();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Start the continuous painting drone */
  startPainting(): void {
    if (!this.enabled || !this.initialized || this.isPlaying) return;
    this.synth?.triggerAttack('C3');
    this.pad?.triggerAttack('G2');
    this.isPlaying = true;
  }

  /** Release the drone */
  stopPainting(): void {
    if (!this.isPlaying) return;
    this.synth?.triggerRelease();
    this.pad?.triggerRelease();
    this.isPlaying = false;
  }

  /** Update synth parameters from current brush state */
  feedBrush(brush: BrushState, canvasW: number, canvasH: number): void {
    if (!this.isPlaying || !this.synth) return;

    // X → stereo pan (-1 left, +1 right)
    const pan = Math.max(-1, Math.min(1, (brush.x / canvasW) * 2 - 1));
    if (this.panner) this.panner.pan.value = pan;

    // Y → pitch (higher at top, lower at bottom)
    const freq = 80 + (1 - brush.y / canvasH) * 350; // 80–430 Hz
    this.synth.frequency.rampTo(freq, 0.15);
    if (this.pad) this.pad.frequency.rampTo(freq * 0.5, 0.2); // octave below

    // Hue → harmonicity (timbral color)
    this.synth.harmonicity.value = 1 + (brush.hue / 360) * 5;

    // Width → filter cutoff (bigger brush = brighter sound)
    const cutoff = 150 + (brush.width / 40) * 2500;
    if (this.filter) this.filter.frequency.rampTo(cutoff, 0.15);

    // Opacity → volume (bolder strokes = louder)
    const vol = -40 + brush.opacity * 18; // -40 to -22 dB
    this.synth.volume.rampTo(vol, 0.15);
    if (this.pad) this.pad.volume.rampTo(vol - 6, 0.15);
  }

  /** Percussive hit on jaw clench stamp */
  stamp(): void {
    if (!this.enabled || !this.initialized) return;
    this.perc?.triggerAttackRelease('C1', '8n');
  }

  dispose(): void {
    this.stopPainting();
    this.synth?.dispose();
    this.pad?.dispose();
    this.perc?.dispose();
    this.filter?.dispose();
    this.panner?.dispose();
    this.delay?.dispose();
    this.reverb?.dispose();
    this.synth = null;
    this.pad = null;
    this.perc = null;
    this.filter = null;
    this.panner = null;
    this.delay = null;
    this.reverb = null;
    this.initialized = false;
  }
}
