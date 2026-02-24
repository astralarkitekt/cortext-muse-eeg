# CORTEX — Muse EEG Observatory

Real-time EEG visualization for Muse headbands (Muse 1, Muse 2, Muse S) using Web Bluetooth.

No subscriptions. No walled gardens. Just your brainwaves.

## What it does

- Connects to your Muse headband directly via Bluetooth
- Streams raw EEG from all 4 channels (TP9, AF7, AF8, TP10)
- Runs real-time FFT to extract frequency band powers (δ θ α β γ)
- Renders live scrolling waveforms on canvas
- Computes Focus and Calm indices
- Tracks session duration and sample count

## Requirements

- **Chrome or Edge** (Web Bluetooth API — Firefox/Safari don't support it)
- A Muse headband (any generation: Muse 1/MU-02, Muse 2/MU-03, Muse S)
- Node.js 18+

## Quick Start

```bash
npm install
npm run dev
```

This opens `http://localhost:3000` in your browser. Click **CONNECT** and select your Muse from the Bluetooth pairing dialog.

## Tips for Good Signal

- Slightly dampen the forehead sensors (a tiny bit of water helps conductivity)
- Make sure the ear sensors are firmly touching behind your ears
- Minimize jaw clenching and eye blinking during observation (or use them as control signals!)
- Wait 5-10 seconds after connecting for the signal to stabilize

## Frequency Bands

| Band  | Range      | Associated with                   |
|-------|------------|-----------------------------------|
| δ Delta | 0.5–4 Hz  | Deep sleep                        |
| θ Theta | 4–8 Hz    | Meditation, creativity, drowsiness |
| α Alpha | 8–13 Hz   | Relaxed awareness, eyes closed    |
| β Beta  | 13–30 Hz  | Active focus, problem solving     |
| γ Gamma | 30–100 Hz | Higher cognition, perception      |

## Architecture

```
src/
  main.ts       → App entry, Muse connection, rendering loop
  signal.ts     → FFT, PSD, band power extraction, rolling buffers
```

Built with:
- **muse-js** — Web Bluetooth connection to Muse
- **Vite** — Dev server and bundler
- **TypeScript** — Because types are good

## Next Steps

Ideas for extending this:

- **Neurofeedback audio** — Map band powers to Web Audio API parameters
- **Generative visuals** — Feed EEG features into WebGL shaders
- **Session recording** — Export raw EEG data as CSV/JSON
- **Brain-Computer Interface** — Blink/jaw clench detection as control inputs
- **WebSocket bridge** — Stream data to external apps (Tau-Tongue integration, etc.)

## License

MIT — Do whatever you want with your own brain data.
