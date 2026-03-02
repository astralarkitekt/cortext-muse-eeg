/**
 * BLINDSIGHT — Eye state detection via frontal alpha blocking.
 *
 * When you close your eyes, alpha power (8–13 Hz) on frontal channels
 * roughly doubles within ~1 second. This is the most robust EEG signal.
 *
 * Detection uses:
 *   - Exponential smoothing on the alpha ratio to filter noise
 *   - Asymmetric thresholds to prevent oscillation
 *   - Hold timers to confirm transitions
 *   - Close: smoothed ratio > 1.4× baseline sustained for 600ms
 *   - Open:  smoothed ratio < 1.15× baseline sustained for 500ms
 */

import type { EyeState } from './types';

const CLOSE_MULTIPLIER = 1.5;   // alpha must clearly jump to confirm close
const OPEN_MULTIPLIER = 1.25;   // forgiving exit — drops below 1.25× = open
const CLOSE_HOLD_MS = 700;      // require 700ms sustained to lock closed
const OPEN_HOLD_MS = 350;       // quick exit once genuinely below threshold
const SMOOTHING = 0.15;         // heavy smoothing rides through Muse noise

export class EyeDetector {
  private baselineAlpha = 0;
  private calibrated = false;

  // Smoothed ratio for noise filtering
  private smoothedRatio = 1;

  // State
  private currentlyClosed = false;
  private closedAt: number | null = null;
  private openedAt: number | null = null;

  // Candidate tracking — separate flags for close vs open transitions
  private closeCandidate = false;
  private closeCandidateTime = 0;
  private openCandidate = false;
  private openCandidateTime = 0;

  /** Set the baseline from calibration */
  setBaseline(alpha: number): void {
    this.baselineAlpha = alpha;
    this.smoothedRatio = 1;
    this.calibrated = true;
  }

  getBaseline(): number {
    return this.baselineAlpha;
  }

  isCalibrated(): boolean {
    return this.calibrated;
  }

  /**
   * Feed frontal alpha power (average of AF7 and AF8).
   * Returns the current eye state.
   */
  feed(frontalAlpha: number): EyeState {
    if (!this.calibrated || this.baselineAlpha <= 0) {
      return { closed: false, closedAt: null, openedAt: null, duration: 0, confidence: 0 };
    }

    const rawRatio = frontalAlpha / this.baselineAlpha;
    this.smoothedRatio += SMOOTHING * (rawRatio - this.smoothedRatio);
    const ratio = this.smoothedRatio;
    const now = Date.now();

    if (!this.currentlyClosed) {
      // Currently open — check for close
      if (ratio > CLOSE_MULTIPLIER) {
        if (!this.closeCandidate) {
          this.closeCandidate = true;
          this.closeCandidateTime = now;
        } else if (now - this.closeCandidateTime >= CLOSE_HOLD_MS) {
          // Confirmed closed
          this.currentlyClosed = true;
          this.closedAt = this.closeCandidateTime;
          this.closeCandidate = false;
          this.openCandidate = false;
        }
      } else {
        this.closeCandidate = false;
      }
    } else {
      // Currently closed — check for open
      if (ratio < OPEN_MULTIPLIER) {
        if (!this.openCandidate) {
          this.openCandidate = true;
          this.openCandidateTime = now;
        } else if (now - this.openCandidateTime >= OPEN_HOLD_MS) {
          // Confirmed open
          this.currentlyClosed = false;
          this.openedAt = now;
          this.openCandidate = false;
          this.closeCandidate = false;
        }
      } else {
        // Still above open threshold — reset opening candidate
        this.openCandidate = false;
      }
    }

    const confidence = this.currentlyClosed
      ? Math.min(1, (ratio - 1) / (CLOSE_MULTIPLIER - 1))
      : Math.min(1, (CLOSE_MULTIPLIER - ratio) / (CLOSE_MULTIPLIER - 1));

    const duration = this.currentlyClosed && this.closedAt
      ? now - this.closedAt
      : 0;

    return {
      closed: this.currentlyClosed,
      closedAt: this.closedAt,
      openedAt: this.openedAt,
      duration,
      confidence: Math.max(0, confidence),
    };
  }

  reset(): void {
    this.currentlyClosed = false;
    this.closeCandidate = false;
    this.closeCandidateTime = 0;
    this.openCandidate = false;
    this.openCandidateTime = 0;
    this.closedAt = null;
    this.openedAt = null;
    this.smoothedRatio = 1;
  }
}
