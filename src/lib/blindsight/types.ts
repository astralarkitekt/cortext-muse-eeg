/**
 * BLINDSIGHT — Shared type definitions
 */

import type { BandPowers } from '../../signal';

// ─── Session Configuration ──────────────────────────────────────────────────

export type RevealMode = 'hard' | 'fade';
export type MappingMode = 'fixed' | 'roundRobin';
export type SymmetryMode = 'none' | 'bilateral' | 'quad';

export interface SessionConfig {
  revealMode: RevealMode;
  mappingMode: MappingMode;
  roundRobinInterval: number;   // ms
  smoothingFactor: number;      // 0.05–0.5
  fadeDuration: number;         // seconds for slow-fade reveal
  symmetryMode: SymmetryMode;
  soundEnabled: boolean;
}

export const DEFAULT_CONFIG: SessionConfig = {
  revealMode: 'fade',
  mappingMode: 'fixed',
  roundRobinInterval: 5000,
  smoothingFactor: 0.2,
  fadeDuration: 2.5,
  symmetryMode: 'none',
  soundEnabled: false,
};

// ─── Stroke Recording (timelapse replay) ─────────────────────────────────

export interface StrokeFrame {
  type: 'stroke' | 'stamp';
  brush: BrushState;
  time: number;        // ms since session start
}

// ─── Gallery ─────────────────────────────────────────────────────────────

export interface GalleryEntry {
  id: string;
  date: string;
  imageData: string;    // scaled JPEG for full view
  thumbData: string;    // tiny thumbnail
  gestures: number;
  paintTimeMs: number;
  dominantBand: string;
  jawClenches: number;
  durationMs: number;
}

// ─── Calibration ─────────────────────────────────────────────────────────────

export interface ChannelBaseline {
  meanAmp: number;
  rms: number;
  min: number;
  max: number;
}

export interface CalibrationData {
  baselineAlpha: number;           // eyes-open frontal alpha power
  closeThreshold: number;          // alpha threshold for eye-close detection
  channelBaselines: Record<string, ChannelBaseline>;
  bandBaselines: BandPowers;
  samples: number;
}

// ─── Eye State ───────────────────────────────────────────────────────────────

export interface EyeState {
  closed: boolean;
  closedAt: number | null;
  openedAt: number | null;
  duration: number;               // current closed duration in ms
  confidence: number;             // 0–1 detection confidence
}

// ─── Brush ───────────────────────────────────────────────────────────────────

export interface BrushState {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  hue: number;            // 0–360
  width: number;          // 2–40 px
  opacity: number;        // 0.1–1.0
  curvature: number;      // 0–1
  texture: number;        // 0–1
}

// ─── Gesture ─────────────────────────────────────────────────────────────────

export interface GestureRecord {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;       // ms
  avgBands: BandPowers;
  strokePoints: number;
  dominantBand: keyof BandPowers;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type BlindState =
  | 'idle'            // waiting for calibration
  | 'calibrating'     // collecting baseline
  | 'waiting'         // eyes open, waiting for gesture
  | 'painting'        // eyes closed, brush active
  | 'revealing'       // eyes opened, fade-in canvas reveal
  | 'complete';       // session finished

export interface SessionSummary {
  totalGestures: number;
  totalPaintTime: number;   // ms
  gestures: GestureRecord[];
  dominantBand: keyof BandPowers;
  durationMs: number;
  jawClenches: number;
}

export interface BlindsightCallbacks {
  onStateChange?: (state: BlindState) => void;
  onCalibrationProgress?: (elapsed: number, total: number) => void;
  onEyeStateChange?: (eye: EyeState) => void;
  onGestureStart?: (index: number) => void;
  onGestureEnd?: (gesture: GestureRecord) => void;
  onBrushUpdate?: (brush: BrushState) => void;
  onRevealProgress?: (progress: number) => void;
  onJawClench?: () => void;
  onReplayProgress?: (progress: number) => void;
  onReplayComplete?: () => void;
}
