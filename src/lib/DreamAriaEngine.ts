import * as Tone from 'tone';

/**
 * dreamAriaEngine v0.6
 * Hybrid binaural + music theory audio engine for dreamHOLD
 * Features: brainwave presets, harmonic pad synth, procedural pizzicato melody, audio-reactive metering
 */

export type BaseFrequency = number;
export type BrainwavePreset = 'delta' | 'theta' | 'alpha' | 'beta' | 'gamma';

// Music Theory Constants
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const SCALES: Record<string, number[]> = {
  'Major': [0, 2, 4, 5, 7, 9, 11],
  'Minor': [0, 2, 3, 5, 7, 8, 10],
  'Dorian': [0, 2, 3, 5, 7, 9, 10],
  'Lydian': [0, 2, 4, 6, 7, 9, 11],
  'Mixolydian': [0, 2, 4, 5, 7, 9, 10]
};

/**
 * Digital root: reduces any positive integer to 1-9.
 * Used to map hash characters to scale degrees for melody generation.
 */
function digitalRoot(n: number): number {
  if (n <= 0) return 9;
  const r = n % 9;
  return r === 0 ? 9 : r;
}

/**
 * 9-degree pitch map from digitalRoot values (1-9) to scale intervals.
 * Degrees 1-7 map to the 7 scale tones; 8 = octave+3rd, 9 = octave+5th.
 * Melody sits in octave 3 (same register as the pad chords, blending with the timbre).
 */
function buildPitchMap(rootNote: string, scaleIntervals: number[]): number[] {
  const root = Tone.Frequency(`${rootNote}3`);
  return [
    root.transpose(scaleIntervals[0]).toFrequency(),  // 1 = root
    root.transpose(scaleIntervals[1]).toFrequency(),  // 2 = 2nd
    root.transpose(scaleIntervals[2]).toFrequency(),  // 3 = 3rd
    root.transpose(scaleIntervals[3]).toFrequency(),  // 4 = 4th
    root.transpose(scaleIntervals[4]).toFrequency(),  // 5 = 5th
    root.transpose(scaleIntervals[5]).toFrequency(),  // 6 = 6th
    root.transpose(scaleIntervals[6]).toFrequency(),  // 7 = 7th
    root.transpose(scaleIntervals[2] + 12).toFrequency(), // 8 = oct+3rd
    root.transpose(scaleIntervals[4] + 12).toFrequency(), // 9 = oct+5th
  ];
}

/**
 * Derive a 72-note melody sequence from the dreamHash.
 * Each base36 character -> digitalRoot(1-9) -> pitch map index.
 * Also derives per-note velocity from the raw base36 value.
 */
function buildMelodyFromHash(
  hash: string,
  pitchMap: number[]
): { frequencies: number[]; velocities: number[] } {
  const frequencies: number[] = [];
  const velocities: number[] = [];
  for (let i = 0; i < hash.length; i++) {
    const raw = parseInt(hash[i], 36); // 0-35
    const dr = digitalRoot(raw || 9);  // 1-9 (treat 0 as 9)
    frequencies.push(pitchMap[dr - 1]);
    // Map raw 0-35 to velocity range 0.3-0.8 for organic dynamics
    velocities.push(0.3 + (raw / 35) * 0.5);
  }
  return { frequencies, velocities };
}

// Brainwave frequency offsets (Hz)
const PRESETS: Record<BrainwavePreset, { offset: number; description: string }> = {
  delta: { offset: 2.5, description: 'Deep sleep / healing' },
  theta: { offset: 6.0, description: 'Meditation / dreams' },
  alpha: { offset: 10.0, description: 'Relaxed focus' },
  beta: { offset: 20.0, description: 'Active thinking' },
  gamma: { offset: 40.0, description: 'Peak awareness' }
};

export interface SessionParams {
  baseFreq: number;
  rootNote: string;
  scaleName: string;
  scaleIntervals: number[];
  currentPreset: BrainwavePreset;
}

export default class DreamAriaEngine {
  private initialized: boolean = false;
  
  // Session state
  private params: SessionParams = {
    baseFreq: 261.63, // Middle C
    rootNote: 'C',
    scaleName: 'Major',
    scaleIntervals: SCALES['Major'],
    currentPreset: 'theta'
  };
  
  // Binaural oscillators
  private leftOsc: Tone.Oscillator | null = null;
  private rightOsc: Tone.Oscillator | null = null;
  private pannerL: Tone.Panner | null = null;
  private pannerR: Tone.Panner | null = null;
  
  // Pad synth (harmonic atmosphere)
  private padSynth: Tone.PolySynth | null = null;
  private autoPanner: Tone.AutoPanner | null = null;
  private chordLoop: Tone.Loop | null = null;
  
  // Noise layer
  private noise: Tone.Noise | null = null;
  private noiseFilter: Tone.Filter | null = null;
  
  // Melody layer (pizzicato arpeggio from dreamHash)
  private pluckSynth: Tone.PluckSynth | null = null;
  private melodyChorus: Tone.Chorus | null = null;
  private melodyReverb: Tone.Reverb | null = null;
  private melodySeq: Tone.Sequence | null = null;
  private melodyNotes: { frequencies: number[]; velocities: number[] } = { frequencies: [], velocities: [] };
  private currentHash: string = '';
  
  // Effects chain
  private reverb: Tone.Reverb | null = null;
  private delay: Tone.PingPongDelay | null = null;
  
  // Metering for visualizer
  private meter: Tone.Meter | null = null;

  public async init(): Promise<void> {
    if (this.initialized) return;

    await Tone.start();
    Tone.Transport.bpm.value = 60;

    // Master effects chain
    this.reverb = new Tone.Reverb({ decay: 6, wet: 0.4 }).toDestination();
    this.delay = new Tone.PingPongDelay('4n', 0.2).connect(this.reverb);
    
    // Meter for audio-reactive visuals
    this.meter = new Tone.Meter();
    this.reverb.connect(this.meter);

    // 1. Binaural Oscillators (core theta wave engine)
    const preset = PRESETS[this.params.currentPreset];
    
    this.leftOsc = new Tone.Oscillator(this.params.baseFreq, 'sine');
    this.rightOsc = new Tone.Oscillator(this.params.baseFreq + preset.offset, 'sine');
    
    this.pannerL = new Tone.Panner(-1).connect(this.delay);
    this.pannerR = new Tone.Panner(1).connect(this.delay);
    
    this.leftOsc.connect(this.pannerL);
    this.rightOsc.connect(this.pannerR);
    
    this.leftOsc.volume.value = -15;
    this.rightOsc.volume.value = -15;

    // 2. Pad Synth (triangle wave polyphonic atmosphere)
    this.padSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 2, decay: 1, sustain: 0.8, release: 3 }
    }).connect(this.reverb);
    
    this.autoPanner = new Tone.AutoPanner(0.1).connect(this.reverb).start();
    this.padSynth.connect(this.autoPanner);
    this.padSynth.volume.value = -20;

    // 3. Brownian Noise (the shield)
    this.noise = new Tone.Noise('brown');
    this.noiseFilter = new Tone.Filter(300, 'lowpass').connect(this.reverb);
    this.noise.connect(this.noiseFilter);
    this.noise.volume.value = -30;

    // 4. Pluck Synth (pizzicato melody from dreamHash)
    //    Own reverb (longer/wetter than master) + chorus for a lush, spacious pluck
    this.melodyReverb = new Tone.Reverb({ decay: 8, wet: 0.55 }).connect(this.reverb);
    this.melodyChorus = new Tone.Chorus({
      frequency: 0.5,
      delayTime: 4,
      depth: 0.6,
      wet: 0.4
    }).connect(this.melodyReverb).start();
    this.pluckSynth = new Tone.PluckSynth({
      attackNoise: 1.2,
      dampening: 2800,
      resonance: 0.96,
      release: 1.5
    }).connect(this.melodyChorus);
    this.pluckSynth.volume.value = -14;

    // Build chord progression loop
    this.buildChordLoop();

    // Build melody loop if hash is already set
    if (this.currentHash) {
      this.buildMelodyLoop();
    }

    this.initialized = true;
  }

  private buildChordLoop(): void {
    if (this.chordLoop) {
      this.chordLoop.dispose();
    }

    const root = Tone.Frequency(`${this.params.rootNote}3`);
    const scaleNotes = this.params.scaleIntervals.map(interval => 
      root.transpose(interval).toFrequency()
    );
    
    // Chord voicings: I (root, 3rd, 5th) and IV (4th, 6th, root)
    const chord1 = [scaleNotes[0], scaleNotes[2], scaleNotes[4]];
    const chord2 = [scaleNotes[3], scaleNotes[5], scaleNotes[0]];
    
    let chordIdx = 0;
    this.chordLoop = new Tone.Loop((time) => {
      const chord = chordIdx % 2 === 0 ? chord1 : chord2;
      this.padSynth?.triggerAttackRelease(chord, '4m', time);
      chordIdx++;
    }, '4m').start(0);
  }

  /**
   * Build the 72-note pizzicato melody loop from the stored dreamHash.
   * Each hash character's digitalRoot (1-9) selects a scale degree.
   * Plays as 8th notes at 60 BPM = 0.5s per note = 36s per cycle.
   * At 3 min, the melody loops exactly 5 times.
   */
  private buildMelodyLoop(): void {
    if (this.melodySeq) {
      this.melodySeq.dispose();
      this.melodySeq = null;
    }

    if (!this.currentHash || !this.pluckSynth) return;

    const pitchMap = buildPitchMap(this.params.rootNote, this.params.scaleIntervals);
    this.melodyNotes = buildMelodyFromHash(this.currentHash, pitchMap);

    // Build array of {freq, vel} objects for the Sequence callback
    const noteEvents = this.melodyNotes.frequencies.map((freq, i) => ({
      freq,
      vel: this.melodyNotes.velocities[i]
    }));

    this.melodySeq = new Tone.Sequence((time, note) => {
      this.pluckSynth?.triggerAttackRelease(note.freq, '8n', time, note.vel);
    }, noteEvents, '8n');

    this.melodySeq.loop = true;
    this.melodySeq.start(0);

    console.log(`[DreamAriaEngine] Melody built: ${noteEvents.length} notes, loop = 36s`);
  }

  public start(): void {
    if (!this.initialized) return;
    this.leftOsc?.start();
    this.rightOsc?.start();
    this.noise?.start();
    Tone.Transport.start();
  }

  public stop(): void {
    Tone.Transport.stop();
    this.leftOsc?.stop();
    this.rightOsc?.stop();
    this.noise?.stop();
    this.padSynth?.releaseAll();
  }

  // --- Fade In/Out ---

  /**
   * Fade in from silence over the specified duration
   * @param durationSec Fade duration in seconds (default 5)
   */
  public fadeIn(durationSec: number = 5): void {
    if (!this.initialized) return;
    
    // Store current target volumes
    const droneTarget = this.leftOsc?.volume.value ?? -15;
    const padTarget = this.padSynth?.volume.value ?? -20;
    const noiseTarget = this.noise?.volume.value ?? -30;
    const melodyTarget = this.pluckSynth?.volume.value ?? -14;
    
    // Start from silence (-60dB is effectively silent)
    this.leftOsc?.volume.setValueAtTime(-60, Tone.now());
    this.rightOsc?.volume.setValueAtTime(-60, Tone.now());
    this.padSynth?.volume.setValueAtTime(-60, Tone.now());
    this.noise?.volume.setValueAtTime(-60, Tone.now());
    this.pluckSynth?.volume.setValueAtTime(-60, Tone.now());
    
    // Ramp up to target volumes
    this.leftOsc?.volume.rampTo(droneTarget, durationSec);
    this.rightOsc?.volume.rampTo(droneTarget, durationSec);
    this.padSynth?.volume.rampTo(padTarget, durationSec);
    this.noise?.volume.rampTo(noiseTarget, durationSec);
    this.pluckSynth?.volume.rampTo(melodyTarget, durationSec);
    
    console.log(`[DreamAriaEngine] Fading in over ${durationSec}s`);
  }

  /**
   * Fade out to silence over the specified duration
   * @param durationSec Fade duration in seconds (default 5)
   * @returns Promise that resolves when fade is complete
   */
  public fadeOut(durationSec: number = 5): Promise<void> {
    if (!this.initialized) {
      return Promise.resolve();
    }
    
    // Ramp all volumes to silence
    this.leftOsc?.volume.rampTo(-60, durationSec);
    this.rightOsc?.volume.rampTo(-60, durationSec);
    this.padSynth?.volume.rampTo(-60, durationSec);
    this.noise?.volume.rampTo(-60, durationSec);
    this.pluckSynth?.volume.rampTo(-60, durationSec);
    
    console.log(`[DreamAriaEngine] Fading out over ${durationSec}s`);
    
    // Return promise that resolves after fade completes
    return new Promise(resolve => {
      setTimeout(resolve, durationSec * 1000);
    });
  }

  // --- Volume Controls ---
  
  public setDroneVolume(val: number): void {
    this.leftOsc?.volume.rampTo(val, 0.1);
    this.rightOsc?.volume.rampTo(val, 0.1);
  }

  public setPadVolume(val: number): void {
    this.padSynth?.volume.rampTo(val, 0.1);
  }

  public setNoiseVolume(val: number): void {
    this.noise?.volume.rampTo(val, 0.1);
  }

  public setMelodyVolume(val: number): void {
    this.pluckSynth?.volume.rampTo(val, 0.1);
  }

  // Legacy alias
  public setToneVolume(val: number): void {
    this.setDroneVolume(val);
  }

  // --- Brainwave Preset ---
  
  public setPreset(preset: BrainwavePreset): void {
    this.params.currentPreset = preset;
    const p = PRESETS[preset];
    this.rightOsc?.frequency.rampTo(this.params.baseFreq + p.offset, 2);
  }

  public getPreset(): BrainwavePreset {
    return this.params.currentPreset;
  }

  public getPresetInfo(): { offset: number; description: string } {
    return PRESETS[this.params.currentPreset];
  }

  // --- Music Theory / Key ---
  
  public setKeyFromHash(hash: string): void {
    // Derive root note from first hash character
    const noteIdx = parseInt(hash[0], 36) % 12;
    this.params.rootNote = NOTES[noteIdx];
    
    // Derive scale from second hash character
    const scaleKeys = Object.keys(SCALES);
    const scaleIdx = parseInt(hash[1], 36) % scaleKeys.length;
    this.params.scaleName = scaleKeys[scaleIdx];
    this.params.scaleIntervals = SCALES[this.params.scaleName];
    
    // Calculate base frequency from root note
    this.params.baseFreq = Tone.Frequency(`${this.params.rootNote}3`).toFrequency();

    // Update oscillators
    const preset = PRESETS[this.params.currentPreset];
    this.leftOsc?.frequency.rampTo(this.params.baseFreq, 1);
    this.rightOsc?.frequency.rampTo(this.params.baseFreq + preset.offset, 1);

    // Store hash for melody generation
    this.currentHash = hash;

    // Rebuild chord loop and melody with new key
    if (this.initialized) {
      this.buildChordLoop();
      this.buildMelodyLoop();
    }
  }

  public getKeySignature(): string {
    return `${this.params.rootNote} ${this.params.scaleName}`;
  }

  public getSessionParams(): SessionParams {
    return { ...this.params };
  }

  // --- Metering for Visuals ---
  
  public getLevel(): number {
    if (!this.meter) return -60;
    const level = this.meter.getValue();
    return typeof level === 'number' ? level : level[0];
  }

  public getEnergy(): number {
    const level = this.getLevel();
    return Math.max(0, (level + 60) / 60);
  }

  // --- Movement/Panning ---
  
  public setMovementSpeed(val: number): void {
    this.autoPanner?.frequency.rampTo(val, 1);
  }

  // Legacy alias
  public setThetaOffset(val: number): void {
    this.rightOsc?.frequency.rampTo(this.params.baseFreq + val, 0.2);
  }

  // Legacy alias (no longer used but kept for compatibility)
  public setKickVolume(_val: number): void {
    // Kick removed in v0.5 - pad synth replaces rhythmic element
  }

  public dispose(): void {
    this.stop();
    
    const nodes = [
      this.leftOsc,
      this.rightOsc,
      this.pannerL,
      this.pannerR,
      this.padSynth,
      this.autoPanner,
      this.chordLoop,
      this.melodySeq,
      this.pluckSynth,
      this.melodyChorus,
      this.melodyReverb,
      this.noise,
      this.noiseFilter,
      this.reverb,
      this.delay,
      this.meter
    ];
    
    nodes.forEach(node => {
      if (node) node.dispose();
    });
    
    this.initialized = false;
  }
}