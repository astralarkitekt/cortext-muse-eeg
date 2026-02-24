# BLINDSIGHT — EEG-Driven Generative Painting

## Concept

A brain-painting application where **closing your eyes creates brushstrokes you can't see until you open them**. Each eyes-closed interval is one "gesture." EEG data from a Muse headband drives every parameter of the brush — position, color, width, opacity, curvature, and texture. You build a painting through a series of meditative moments you never directly witness being created.

The painting is a literal map of your meditative experience.

## Hardware

- **Muse EEG Headband** (MU-02/Muse 1, Muse 2, or Muse S)
- Connects via Web Bluetooth API (Chrome/Edge required)
- 4 EEG channels: AF7, AF8 (forehead), TP9, TP10 (ears)
- 256Hz sample rate, 12 samples per reading packet

## Dependencies

- **muse-js** — Web Bluetooth EEG connection library (uses RxJS observables)
- **Vite + TypeScript** — Build tooling
- **HTML5 Canvas or WebGL** — Rendering engine
- Custom FFT/signal processing (we have working implementations in the CORTEX project I believe)

## Architecture

```
EEG Stream (muse-js)
    → Eye State Detector (frontal alpha threshold)
        → [EYES CLOSED] → Painting active, canvas hidden
            → Channel Demuxer (round robin or fixed mapping)
                → AF7 → X position
                → AF8 → Y position
                → TP9 → Color / hue
                → TP10 → Brush width
            → Band Power Extractor (per-epoch FFT, 1s window)
                → Alpha power → Opacity
                → Theta power → Stroke curvature
                → Beta power → Texture / grain
            → Canvas Renderer
        → [EYES OPEN] → Painting stops, canvas revealed
```

## Eye State Detection

Alpha power (8–13 Hz) on the frontal channels (AF7, AF8) approximately doubles within ~1 second of eye closure. This is called "alpha blocking" and is one of the most robust signals in EEG.

### Implementation

1. **Calibration phase (15 seconds at session start):**
   - Record baseline alpha power on AF7 and AF8 with eyes open
   - Store as `baselineAlpha`

2. **Detection logic:**
   - Compute alpha power on AF7 and AF8 using a 1-second sliding FFT window
   - Average the two channels: `frontalAlpha = (af7Alpha + af8Alpha) / 2`
   - If `frontalAlpha > baselineAlpha * 1.5` for at least 500ms → eyes closed
   - If `frontalAlpha < baselineAlpha * 1.2` for at least 300ms → eyes open
   - The asymmetric thresholds and hold times prevent rapid toggling

```typescript
interface EyeState {
  closed: boolean;
  closedAt: number | null;    // timestamp of eye close
  openedAt: number | null;    // timestamp of eye open
  duration: number;           // current closed duration in ms
}

const CLOSE_THRESHOLD = 1.5;  // multiplier above baseline
const OPEN_THRESHOLD = 1.2;   // multiplier above baseline
const CLOSE_HOLD_MS = 500;    // debounce for close detection
const OPEN_HOLD_MS = 300;     // debounce for open detection
```

## Parameter Mapping

### Spatial Parameters (frontal channels — cleaner signal)

| Channel | Parameter | Mapping Logic |
|---------|-----------|---------------|
| AF7 amplitude | X position | Smoothed amplitude maps to horizontal brush position. EEG amplitude fluctuates organically, producing smooth wandering paths rather than chaotic scatter. |
| AF8 amplitude | Y position | Same approach for vertical axis. Left and right prefrontal cortex literally steer the brush. |

### Brush Character (temporal channels — noisier, used as texture)

| Channel | Parameter | Mapping Logic |
|---------|-----------|---------------|
| TP9 band ratio | Color / Hue | `theta / beta` ratio maps to a color gradient. Theta-dominant (meditative) → cool blues/purples. Beta-dominant (active) → warm oranges/reds. |
| TP10 peak-to-peak | Brush width | Larger signal swings (max - min across 12 samples) → wider strokes. Quiet signal → fine detail. Range: 2px to 40px. |

### Band Power Parameters (computed per-epoch via FFT)

| Band | Parameter | Mapping Logic |
|------|-----------|---------------|
| Alpha (8–13 Hz) | Opacity | Higher alpha = more opaque, more vivid marks. Natural reward: deeper relaxation → bolder painting. Range: 0.1 to 1.0. |
| Theta (4–8 Hz) | Stroke curvature | Higher theta = flowing curves (bezier with larger control point offsets). Lower theta = angular, straight marks. |
| Beta (13–30 Hz) | Texture / grain | Higher beta = stipple, noise, roughness added to the brush. Active thinking adds visual complexity. |

### Normalization

All parameters must be mapped relative to the session baseline, not absolute values:

```typescript
function normalize(current: number, baseline: number, range: number = 2): number {
  // Map to 0–1 where 0 = baseline, 1 = baseline * range
  return Math.max(0, Math.min(1, (current - baseline) / (baseline * (range - 1))));
}
```

### Smoothing

Raw EEG values are jittery. All mapped parameters must use exponential smoothing:

```typescript
function smooth(current: number, previous: number, factor: number = 0.15): number {
  return previous + factor * (current - previous);
}
```

Time constants should be 0.3–1.0 seconds. The brain doesn't change state in 100ms, so visual parameters shouldn't either.

## Round Robin Mode (Optional)

Instead of fixed channel-to-parameter mappings, rotate which channel controls which parameter every N seconds (e.g., every 5 seconds). This means the same mental state produces different visual outcomes at different moments, introducing structured variation.

```typescript
const MAPPING_ROTATION_INTERVAL = 5000; // ms
const PARAMETER_SLOTS = ['xPos', 'yPos', 'color', 'width'] as const;
const CHANNELS = ['AF7', 'AF8', 'TP9', 'TP10'] as const;

// Rotate channel assignments every interval
let rotationIndex = 0;
setInterval(() => {
  rotationIndex = (rotationIndex + 1) % 4;
  // Shift channel-to-parameter assignments by one position
}, MAPPING_ROTATION_INTERVAL);
```

## Canvas Rendering

### Brush Engine

Each animation frame during eyes-closed state:

1. Read current mapped parameters (position, color, width, opacity, curvature, texture)
2. Draw a short stroke segment from previous position to current position
3. Apply curvature via bezier control points
4. Apply texture via jittered sub-strokes or noise displacement
5. Composite onto the main canvas with current opacity

```typescript
interface BrushState {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  hue: number;
  width: number;
  opacity: number;
  curvature: number;
  texture: number;
}

function renderStrokeSegment(ctx: CanvasRenderingContext2D, brush: BrushState): void {
  ctx.globalAlpha = brush.opacity;
  ctx.strokeStyle = `hsl(${brush.hue}, 70%, 60%)`;
  ctx.lineWidth = brush.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Bezier control points offset by curvature
  const cpOffset = brush.curvature * 50;
  const cpX = (brush.prevX + brush.x) / 2 + (Math.random() - 0.5) * cpOffset;
  const cpY = (brush.prevY + brush.y) / 2 + (Math.random() - 0.5) * cpOffset;

  ctx.beginPath();
  ctx.moveTo(brush.prevX, brush.prevY);
  ctx.quadraticCurveTo(cpX, cpY, brush.x, brush.y);
  ctx.stroke();

  // Texture: add stipple dots along the stroke path
  if (brush.texture > 0.3) {
    const dots = Math.floor(brush.texture * 8);
    for (let i = 0; i < dots; i++) {
      const t = Math.random();
      const dotX = brush.prevX + (brush.x - brush.prevX) * t + (Math.random() - 0.5) * brush.width;
      const dotY = brush.prevY + (brush.y - brush.prevY) * t + (Math.random() - 0.5) * brush.width;
      ctx.globalAlpha = brush.opacity * 0.3;
      ctx.beginPath();
      ctx.arc(dotX, dotY, brush.width * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
```

### Reveal Mechanic

Three options to implement (expose as a setting):

1. **Hard cut** — Canvas is black/blurred while eyes closed, instant reveal on open. Maximum surprise. Simplest to implement — toggle a CSS overlay.

2. **Slow fade** — Canvas gradually becomes visible over 2–3 seconds after eyes open, like a Polaroid developing.

```typescript
// On eye open detected:
let revealProgress = 0;
function revealAnimation() {
  revealProgress += 0.02; // ~2 seconds to full reveal at 60fps
  overlay.style.opacity = `${1 - revealProgress}`;
  if (revealProgress < 1) requestAnimationFrame(revealAnimation);
}
```

3. **Afterimage** — You see the *previous* gesture's result while the current one is being painted. Always one step behind your own brain. Requires double-buffering with two canvas layers.

## Calibration Flow

1. App loads → "Stare at the center dot. Keep your eyes open." (10 seconds)
2. Record baseline alpha, amplitude stats for all channels
3. "Close your eyes for 5 seconds." → Record eyes-closed alpha
4. Compute threshold: `closeThreshold = (openAlpha + closedAlpha) / 2`
5. "Calibration complete. Close your eyes to begin painting."

## Session Flow

```
[CALIBRATE] → 15 seconds
    ↓
[IDLE] → Canvas visible, waiting for first eye close
    ↓
[PAINTING] → Eyes closed detected
    ↓ Canvas hidden (overlay active)
    ↓ Brush rendering from EEG data
    ↓ Gesture counter increments
    ↓
[REVEAL] → Eyes open detected
    ↓ Canvas shown (overlay fades)
    ↓ User sees result of their gesture
    ↓
[IDLE] → Waiting for next eye close
    ↓ (repeat until session ends)
    ↓
[COMPLETE] → User clicks "Finish"
    ↓ Final painting displayed
    ↓ Option to save as PNG
    ↓ Session summary: gesture count, total paint time, dominant bands
```

## UI Layout

```
┌─────────────────────────────────────────────────────┐
│ BLINDSIGHT                    [Calibrate] [Finish]  │
│ gesture: 7 | paint time: 0:42 | state: EYES OPEN   │
├─────────────────────────────────────────────────────┤
│                                                     │
│                                                     │
│                  CANVAS AREA                        │
│                  (full width, square or 16:9)        │
│                                                     │
│                                                     │
│                  [OVERLAY: solid black or blur       │
│                   when eyes closed]                  │
│                                                     │
│                                                     │
├─────────────────────────────────────────────────────┤
│ α 63.2  θ 48.1  β 55.0  │  AF7 ● AF8 ● TP9 ● TP10●│
│ [reveal: hard ▾]          │  brush: ━━━━━  hue: ███ │
└─────────────────────────────────────────────────────┘
```

## File Structure

```
blindsight/
├── index.html              # Entry point
├── vite.config.ts
├── tsconfig.json
├── package.json
├── src/
│   ├── main.ts             # App entry, session orchestration
│   ├── muse.ts             # Muse connection, EEG stream management
│   ├── signal.ts           # FFT, band power extraction, rolling buffers
│   │                         (port from CORTEX project)
│   ├── eye-detect.ts       # Eye state detection (alpha threshold)
│   ├── mapper.ts           # EEG → brush parameter mapping + normalization
│   ├── brush.ts            # Canvas brush engine + stroke rendering
│   ├── canvas.ts           # Canvas management, overlay, reveal mechanics
│   ├── calibration.ts      # Calibration flow + baseline computation
│   ├── ui.ts               # Status bar, metrics display, controls
│   └── types.ts            # Shared TypeScript interfaces
```

## Key Interfaces

```typescript
interface SessionConfig {
  revealMode: 'hard' | 'fade' | 'afterimage';
  mappingMode: 'fixed' | 'roundRobin';
  roundRobinInterval: number;        // ms, only used if roundRobin
  canvasWidth: number;
  canvasHeight: number;
  smoothingFactor: number;           // 0.05 to 0.3
  calibrationDuration: number;       // ms
}

interface CalibrationData {
  baselineAlpha: number;             // eyes-open alpha power
  closedAlpha: number;               // eyes-closed alpha power
  closeThreshold: number;            // computed detection threshold
  channelBaselines: {
    AF7: { meanAmp: number; rms: number };
    AF8: { meanAmp: number; rms: number };
    TP9: { meanAmp: number; rms: number };
    TP10: { meanAmp: number; rms: number };
  };
  bandBaselines: BandPowers;         // baseline power per band
}

interface BandPowers {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

interface BrushState {
  x: number;                         // canvas X position (0 to width)
  y: number;                         // canvas Y position (0 to height)
  prevX: number;
  prevY: number;
  hue: number;                       // 0–360
  width: number;                     // px, 2–40
  opacity: number;                   // 0.1–1.0
  curvature: number;                 // 0–1
  texture: number;                   // 0–1
}

interface EyeState {
  closed: boolean;
  closedAt: number | null;
  openedAt: number | null;
  duration: number;
}

interface GestureRecord {
  index: number;
  startTime: number;
  endTime: number;
  duration: number;
  avgBands: BandPowers;
  strokePoints: number;
  dominantBand: keyof BandPowers;
}

interface SessionSummary {
  totalGestures: number;
  totalPaintTime: number;            // ms
  gestures: GestureRecord[];
  dominantBand: keyof BandPowers;
  canvasDataUrl: string;             // PNG export
}
```

## Signal Processing Notes

- FFT window: 256 samples (1 second at 256Hz) with Hanning window
- FFT update rate: ~10Hz (every 100ms)
- Band extraction: sum PSD bins within each frequency range
- Artifact rejection: flag epochs where peak-to-peak > 200µV
- All band powers should be in dB µV² (10 * log10(power * 1e6))
- Normalize all control signals relative to calibration baseline, not absolute values

## Sensor Placement Reference

- **AF7** — Left forehead, left prefrontal cortex (analytical, language)
- **AF8** — Right forehead, right prefrontal cortex (creative, spatial)
- **TP9** — Left ear, left temporal-parietal (auditory, memory)
- **TP10** — Right ear, right temporal-parietal (social cognition, spatial)
- Odd numbers = left hemisphere, even numbers = right hemisphere

## Prior Art & Context

This project extends the CORTEX EEG Observatory (v0.2.0) which already implements:
- Muse connection via muse-js and Web Bluetooth
- Real-time FFT and band power extraction
- Rolling buffers for continuous EEG data
- Session recording and CSV export
- Signal quality metrics (mean amplitude, peak-to-peak, RMS)

The `signal.ts` module from CORTEX can be ported directly. The Muse connection logic in `main.ts` can be refactored into the `muse.ts` module.

## Tips for Good Signal

- Wipe forehead and behind ears to remove oil before sessions
- Lightly dampen skin with water for better conductivity
- Tighten ear hooks for firm TP9/TP10 contact
- Relax forehead muscles and jaw consciously
- Allow 10+ seconds for electrodes to settle before calibration
