# CORTEX — Muse EEG Neurofeedback Platform

Real-time EEG visualization, neurofeedback audio synthesis, session analytics, and brain-painting — all running in the browser with a sub-$100 Muse headband.

No backend. No subscriptions. No SDK. Just `npm run dev` and strap on your headband.

---

## What It Does

CORTEX is a four-tab platform that turns a consumer EEG headband into a neuroscience workstation:

| Tab | What it does |
|-----|-------------|
| **Monitor** | Live 4-channel EEG waveforms, frequency band powers, focus/calm scoring, CSV export |
| **Neuro** | Real-time neurofeedback audio — 7 synth layers that breathe with your brain state |
| **Analyze** | Post-session analysis of exported CSVs with Recharts visualizations and auto-trimming |
| **Blindsight** | Eyes-closed generative brain-painting with EOG eye-steering, sonification, and GIF export |

All tabs stay mounted simultaneously (hidden via `display: none`), so switching tabs never interrupts a live session.

---

## Requirements

- **Chrome or Edge** (Web Bluetooth API — Firefox and Safari don't support it)
- A **Muse headband** — any generation: Muse 1 (MU-02), Muse 2 (MU-03), or Muse S
- **Node.js 18+**

The Muse MU-02 goes for under $10 on eBay. That's all you need.

## Quick Start

```bash
npm install
npm run dev
```

Opens `http://localhost:3000`. Click **CONNECT** and select your Muse from the Bluetooth pairing dialog.

---

## The Tabs

### Monitor — Real-Time EEG Observatory

The dashboard. Four panels:

- **EEG Waveforms** — Full-width canvas rendering all 4 channels (TP9, AF7, AF8, TP10), color-coded, with scrolling time window
- **Frequency Bands** — Live bar chart of δ / θ / α / β / γ power
- **Metrics** — Focus score, calm score, sample count, session duration
- **Actions** — CSV export (last 30s / 1min / 2min / 5min / full session), audio file playback for session accompaniment

Under the hood: 256 Hz sample rate, 4-second rolling buffers (1024 samples per channel), FFT band extraction every 100ms with exponential smoothing.

### Neuro — Neurofeedback Audio Synthesis

NEURO-ARIA maps your brain state to a layered Tone.js soundscape in real time. Seven synthesis layers:

| Layer | Sound | EEG Mapping |
|-------|-------|-------------|
| **Drone** | Sine + triangle oscillators | Alpha → filter cutoff & gain; Delta → base frequency |
| **Pad** | Polyphonic triangle chords | Theta → reverb wet & voicing |
| **Sub** | Deep sine oscillator | Delta → volume |
| **Texture** | Brown noise through bandpass | Beta → filter frequency & resonance |
| **Spatial** | Stereo panning | Frontal asymmetry (AF7 vs AF8) |
| **Pluck** | Melodic chime notes | Spike detection → pentatonic scale triggers |
| **Shimmer** | Fast crystalline arpeggiation | Gamma → note bursts |

15-second calibration baseline. All mappings are baseline-relative with heavy exponential smoothing, so it responds to *your* brain, not some absolute threshold. Generates session reports with dominant-state tracking, spike counts, and full telemetry.

### Analyze — Session Analysis

Import an exported CSV and get offline analysis with Recharts:

- Time-series band power plots (line, area, bar)
- Per-channel waveform inspection
- Signal quality metrics (mean amplitude, peak-to-peak, RMS)
- Configurable settling-period auto-trim (default 10s) to discard noisy startup data

Uses the same FFT pipeline as the live monitor to reprocess recorded sessions.

### Blindsight — Brain-Painting

Close your eyes. Your brain paints a picture you've never seen. Open your eyes. It's revealed.

**How it works:**

1. **15-second calibration** — establishes per-channel baselines
2. **Eye detection** — frontal alpha blocking (α power roughly doubles when you close your eyes). Asymmetric thresholds with hold timers prevent oscillation
3. **EOG eye-steering** — your eyeballs move behind closed lids, creating voltage differentials on AF7/AF8. The system reads these as joystick input: `AF7 − AF8` → horizontal velocity, `(AF7 + AF8) mean shift` → vertical velocity. Dead zones, drift decay, and heavy smoothing keep it stable on the noisy Muse signal
4. **Painting** — continuous brush strokes driven by EEG parameters:

| Parameter | Source | What it does |
|-----------|--------|-------------|
| X/Y velocity | EOG differential | Eye-steered brush movement |
| Hue | TP9 θ/β ratio | Cool blues when meditative, warm oranges when focused |
| Width | TP10 peak-to-peak | Brush size |
| Opacity | Alpha power | Bolder marks in deep relaxation |
| Curvature | Theta power | Flowing bezier curves in meditative states |
| Texture | Beta power | Stipple grain from active thinking |
| Stamp | Jaw clench (TP9+TP10 RMS spike) | Sharp burst mark + percussive sound hit |

5. **Reveal** — radial dissolve from center outward, using destination-out compositing with a cyan glow ring at the expanding edge

**Extra features:**

- **Symmetry modes** — none, bilateral (vertical mirror), or quad (4-fold)
- **Ambient sonification** — FM synth drone + AM pad layer map brush state to audio in real time (pitch follows Y, pan follows X, filter follows width, membrane perc on jaw clench)
- **Timelapse replay** — every stroke frame is recorded; replay the entire painting process at 8× speed
- **GIF export** — renders the replay timelapse to an animated GIF (480px, 12 FPS, 256-color quantized) and downloads it
- **Gallery** — save paintings to localStorage (JPEG thumbnails, max 20 entries), browse and delete past works
- **PNG export** — download the finished painting as a full-resolution PNG

---

## Signal Processing

All DSP runs client-side in [src/signal.ts](src/signal.ts):

- **Radix-2 Cooley-Tukey FFT** — iterative, in-place, with bit-reversal permutation. Auto-pads to next power of 2
- **Hanning windowing** — reduces spectral leakage at window edges
- **Power Spectral Density** — computed per frequency bin from FFT output
- **Five-band decomposition**:

| Band | Range | Associated with |
|------|-------|-----------------|
| δ Delta | 0.5–4 Hz | Deep sleep, unconscious processing |
| θ Theta | 4–8 Hz | Meditation, creativity, drowsiness |
| α Alpha | 8–13 Hz | Relaxed awareness, eyes closed |
| β Beta | 13–30 Hz | Active focus, problem solving |
| γ Gamma | 30–100 Hz | Higher cognition, peak states |

- **RollingBuffer** — circular buffer class with `push()`, `getOrdered()`, `getRecent(n)` for continuous per-channel data

All math uses `Float64Array` for performance. 256-sample FFT windows = one second of data at 256 Hz.

---

## Architecture

```
src/
├── main.tsx                  → App entry point
├── App.tsx                   → Tab shell, connection UI, electrode quality pips
├── signal.ts                 → FFT, PSD, band extraction, RollingBuffer
├── monitor-engine.ts         → Muse BLE connection, EEG streaming, pub/sub
├── styles.css                → All styles
│
├── pages/
│   ├── Monitor.tsx           → Live EEG dashboard
│   ├── Neuro.tsx             → Neurofeedback audio + visualization
│   ├── Analyze.tsx           → Post-session CSV analysis
│   └── Blindsight.tsx        → Brain-painting UI
│
└── lib/
    ├── NeuroEngine.ts        → 7-layer Tone.js neurofeedback synth (~750 lines)
    ├── DreamAriaEngine.ts    → Binaural beat + procedural melody engine
    │
    └── blindsight/
        ├── types.ts          → Shared types (BrushState, SessionConfig, StrokeFrame, etc.)
        ├── engine.ts         → Session state machine (idle→calibrating→painting→complete)
        ├── eye-detect.ts     → Alpha-blocking eye state detection
        ├── mapper.ts         → EOG steering + band power → brush parameter mapping
        ├── brush.ts          → Canvas rendering (strokes, stamps, symmetry, reveal)
        ├── sonify.ts         → Brush-state-to-audio mapping (FM/AM/membrane synths)
        ├── gallery.ts        → localStorage gallery persistence
        └── gif-export.ts     → Animated GIF encoder using gifenc
```

## Stack

- **[muse-js](https://github.com/urish/muse-js)** — Web Bluetooth connection to Muse headbands
- **[Tone.js](https://tonejs.github.io/)** — Audio synthesis (NeuroEngine + BrainSonifier)
- **[React 19](https://react.dev/)** — UI
- **[Recharts](https://recharts.org/)** — Data visualization in Analyze tab
- **[gifenc](https://github.com/mattdesl/gifenc)** — Lightweight browser GIF encoding
- **[Vite](https://vite.dev/)** — Dev server and bundler
- **TypeScript** — Because types are good

---

## Tips for Good Signal

- **Clean your skin and electrodes** — skin oils are insulators. A quick wipe drops peak-to-peak noise by ~16%
- **Skip over-ear headphones** — the cup drivers sit on TP9/TP10 and flood the gamma band with electromagnetic interference. IEMs or nothing
- **Skip the beanie** — loose fabric couples to the headband and generates broadband noise from micro-movement. The headband holds fine on its own
- **Wait 90 seconds** — electrode impedance needs time to stabilize. Peak-to-peak voltage drops from ~50µV to ~25µV after settling
- **Dampen the forehead sensors** — a tiny bit of water helps conductivity
- **Ear sensors firm** — make sure they're touching behind your ears, not sitting on top of them

---

## License

MIT — Do whatever you want with your own brain data.
