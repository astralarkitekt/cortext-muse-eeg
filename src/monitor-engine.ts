/**
 * Monitor engine — imperative EEG monitoring logic.
 * Extracted from the original main.ts to be mounted/unmounted
 * by the React Monitor component.
 */

import { MuseClient } from 'muse-js';
import { RollingBuffer, extractBandPowers, type BandPowers } from './signal';

// ─── Constants ───────────────────────────────────────────────────────────────

const EEG_SAMPLE_RATE = 256;
const BUFFER_SECONDS = 4;
const BUFFER_SIZE = EEG_SAMPLE_RATE * BUFFER_SECONDS;
const FFT_WINDOW_SAMPLES = 256;
const FFT_UPDATE_INTERVAL = 100;

const CHANNEL_NAMES = ['TP9', 'AF7', 'AF8', 'TP10'] as const;
const CHANNEL_COLORS = ['#818cf8', '#22d3ee', '#34d399', '#fbbf24'];

const BAND_NAMES: (keyof BandPowers)[] = ['delta', 'theta', 'alpha', 'beta', 'gamma'];

// ─── State ───────────────────────────────────────────────────────────────────

let museClient: MuseClient | null = null;
let isConnected = false;
let isStreaming = false;
let sessionStart: number | null = null;
let totalSamples = 0;

const channelBuffers: RollingBuffer[] = CHANNEL_NAMES.map(() => new RollingBuffer(BUFFER_SIZE));
const sessionRecording: { timestamp: number; channel: number; samples: number[] }[] = [];

let currentBands: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
let smoothedBands: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
let maxBandPower = 0.001;

// Audio state
let audioContext: AudioContext | null = null;
let audioBuffer: AudioBuffer | null = null;
let audioSource: AudioBufferSourceNode | null = null;
let audioIsPlaying = false;
let audioStartTime = 0;
let audioPauseOffset = 0;
let loadedAudioName = '';

// DOM refs (set during init)
let $: (id: string) => HTMLElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let animFrameId: number | null = null;
let resizeHandler: (() => void) | null = null;
let outsideClickHandler: ((e: MouseEvent) => void) | null = null;

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string, level: 'info' | 'success' | 'error' | 'warn' = 'info') {
  const logContent = $('log-content');
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  const div = document.createElement('div');
  div.className = level;
  div.textContent = `[${ts}] ${msg}`;
  logContent.appendChild(div);
  logContent.scrollTop = logContent.scrollHeight;
}

// ─── Muse Connection ─────────────────────────────────────────────────────────

async function connect() {
  if (isConnected) {
    disconnect();
    return;
  }

  try {
    log('Requesting Bluetooth device...');
    museClient = new MuseClient();
    museClient.enableAux = false;

    await museClient.connect();
    log('Bluetooth connected!', 'success');

    isConnected = true;
    updateConnectionUI();

    await museClient.start();
    log('EEG streaming started. Place headband on forehead.', 'success');

    isStreaming = true;
    sessionStart = Date.now();
    $('idle-overlay').classList.add('hidden');
    updateConnectionUI();

    museClient.eegReadings.subscribe((reading) => {
      const ch = reading.electrode;
      if (ch >= 0 && ch < 4) {
        channelBuffers[ch].push(reading.samples);
        totalSamples += reading.samples.length;
        sessionRecording.push({
          timestamp: Date.now(),
          channel: ch,
          samples: Array.from(reading.samples),
        });
      }
    });

    ($('export-btn') as HTMLButtonElement).disabled = false;

    museClient.telemetryData.subscribe((telemetry) => {
      log(`Battery: ${telemetry.batteryLevel.toFixed(1)}% | Temp: ${telemetry.temperature}°C`, 'info');
    });

    log('Subscribed to EEG channels. Observing brainwaves...', 'success');
  } catch (err: any) {
    log(`Connection failed: ${err.message || err}`, 'error');
    isConnected = false;
    isStreaming = false;
    updateConnectionUI();
  }
}

function disconnect() {
  if (museClient) {
    try { museClient.disconnect(); } catch { /* ignore */ }
  }
  museClient = null;
  isConnected = false;
  isStreaming = false;
  sessionStart = null;
  totalSamples = 0;
  channelBuffers.forEach((b) => b.clear());
  sessionRecording.length = 0;
  currentBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  smoothedBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  maxBandPower = 0.001;
  $('idle-overlay').classList.remove('hidden');
  ($('export-btn') as HTMLButtonElement).disabled = true;
  updateConnectionUI();
  log('Disconnected.', 'warn');
}

function updateConnectionUI() {
  const statusDot = $('status-dot');
  const statusText = $('status-text');
  const connectBtn = $('connect-btn') as HTMLButtonElement;
  statusDot.className = 'status-dot' + (isStreaming ? ' streaming' : isConnected ? ' connected' : '');
  statusText.textContent = isStreaming ? 'streaming' : isConnected ? 'connected' : 'disconnected';
  connectBtn.textContent = isConnected ? 'Disconnect' : 'Connect';
  connectBtn.classList.toggle('connected', isConnected);
}

// ─── FFT / Band Power ────────────────────────────────────────────────────────

function updateBandPowers() {
  if (!isStreaming) return;

  const allBands: BandPowers[] = [];
  for (let ch = 0; ch < 4; ch++) {
    if (channelBuffers[ch].count < FFT_WINDOW_SAMPLES) continue;
    const samples = channelBuffers[ch].getRecent(FFT_WINDOW_SAMPLES);
    const bands = extractBandPowers(samples, EEG_SAMPLE_RATE);
    allBands.push(bands);
  }
  if (allBands.length === 0) return;

  currentBands = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  for (const band of allBands) {
    for (const name of BAND_NAMES) {
      currentBands[name] += band[name] / allBands.length;
    }
  }

  const alpha = 0.3;
  for (const name of BAND_NAMES) {
    smoothedBands[name] = smoothedBands[name] * (1 - alpha) + currentBands[name] * alpha;
    if (smoothedBands[name] > maxBandPower) maxBandPower = smoothedBands[name];
  }
  maxBandPower *= 0.9995;

  updateBandUI();
  updateMetrics();
}

function updateBandUI() {
  for (const name of BAND_NAMES) {
    const bar = $(`band-${name}`) as HTMLDivElement;
    const val = $(`val-${name}`);
    const pct = Math.min(100, (smoothedBands[name] / maxBandPower) * 100);
    bar.style.width = `${pct}%`;
    const db = smoothedBands[name] > 0
      ? (10 * Math.log10(smoothedBands[name] * 1e6)).toFixed(1)
      : '—';
    val.textContent = `${db}`;
  }
}

function updateMetrics() {
  const focusDenom = smoothedBands.alpha + smoothedBands.theta;
  const focus = focusDenom > 0 ? smoothedBands.beta / focusDenom : 0;
  ($('metric-focus')).textContent = `${Math.min(99, Math.round(focus * 50))}`;

  const calm = smoothedBands.beta > 0 ? smoothedBands.alpha / smoothedBands.beta : 0;
  ($('metric-calm')).textContent = `${Math.min(99, Math.round(calm * 30))}`;

  const sampleK = totalSamples > 1000 ? `${(totalSamples / 1000).toFixed(1)}k` : `${totalSamples}`;
  ($('metric-samples')).textContent = sampleK;

  if (sessionStart) {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    ($('metric-time')).textContent = `${min}:${sec.toString().padStart(2, '0')}`;
  }
}

// ─── Canvas Rendering ────────────────────────────────────────────────────────

function resizeCanvas() {
  const rect = canvas.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = 480 * dpr;
  canvas.style.height = '480px';
  ctx.scale(dpr, dpr);
}

function drawWaveforms() {
  const w = canvas.clientWidth;
  const h = 480;
  const channelHeight = h / 4;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = '#1a1a28';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = i * channelHeight;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  const samplesVisible = BUFFER_SIZE;
  const pxPerSample = w / samplesVisible;
  const gridSamples = EEG_SAMPLE_RATE / 2;
  ctx.strokeStyle = '#151520';
  for (let s = 0; s < samplesVisible; s += gridSamples) {
    const x = s * pxPerSample;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  for (let ch = 0; ch < 4; ch++) {
    const buffer = channelBuffers[ch];
    if (buffer.count < 2) continue;

    const data = buffer.getOrdered();
    const yCenter = ch * channelHeight + channelHeight / 2;
    const scale = channelHeight / 2 / 400;

    ctx.strokeStyle = CHANNEL_COLORS[ch];
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.9;
    ctx.shadowColor = CHANNEL_COLORS[ch];
    ctx.shadowBlur = 4;

    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / samplesVisible) * w;
      const y = yCenter - data[i] * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    ctx.fillStyle = CHANNEL_COLORS[ch];
    ctx.globalAlpha = 0.4;
    ctx.font = '11px "JetBrains Mono"';
    ctx.fillText(CHANNEL_NAMES[ch], 8, ch * channelHeight + 18);
    ctx.globalAlpha = 1;

    ctx.strokeStyle = CHANNEL_COLORS[ch];
    ctx.globalAlpha = 0.1;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yCenter);
    ctx.lineTo(w, yCenter);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

// ─── Animation Loop ──────────────────────────────────────────────────────────

let lastFFTUpdate = 0;

function animate(time: number) {
  drawWaveforms();
  if (time - lastFFTUpdate > FFT_UPDATE_INTERVAL) {
    updateBandPowers();
    lastFFTUpdate = time;
  }
  animFrameId = requestAnimationFrame(animate);
}

// ─── Export ──────────────────────────────────────────────────────────────────

function toggleExportDropdown() {
  const exportDropdown = $('export-dropdown');
  const isOpen = exportDropdown.classList.contains('open');
  if (isOpen) {
    exportDropdown.classList.remove('open');
  } else {
    const elapsed = sessionStart ? (Date.now() - sessionStart) / 1000 : 0;
    exportDropdown.querySelectorAll('.export-option').forEach((opt) => {
      const btn = opt as HTMLButtonElement;
      const sec = parseInt(btn.dataset.seconds || '0');
      btn.disabled = sec > 0 && sec > elapsed;
    });
    exportDropdown.classList.add('open');
  }
}

function exportSessionData(seconds: number) {
  $('export-dropdown').classList.remove('open');

  if (sessionRecording.length === 0) {
    log('No data to export.', 'warn');
    return;
  }

  const now = Date.now();
  const cutoff = seconds > 0 ? now - seconds * 1000 : 0;
  const filtered = sessionRecording.filter((r) => r.timestamp >= cutoff);

  if (filtered.length === 0) {
    log('No data in selected range.', 'warn');
    return;
  }

  const maxSamples = Math.max(...filtered.map((r) => r.samples.length));
  const header = ['timestamp_ms', 'channel', ...Array.from({ length: maxSamples }, (_, i) => `sample_${i}`)];
  const csvRows = [header.join(',')];

  for (const rec of filtered) {
    const row = [
      rec.timestamp.toString(),
      CHANNEL_NAMES[rec.channel],
      ...rec.samples.map((v) => v.toFixed(4)),
    ];
    while (row.length < header.length) row.push('');
    csvRows.push(row.join(','));
  }

  const csv = csvRows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const label = seconds > 0 ? `${seconds}s` : 'full';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `cortex-eeg-${label}-${ts}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  const sampleCount = filtered.reduce((s, r) => s + r.samples.length, 0);
  log(`Exported ${filtered.length} packets (${sampleCount} samples) as CSV.`, 'success');
}

// ─── Audio Controls ──────────────────────────────────────────────────────────

function loadAudioFile() {
  ($('audio-file-input') as HTMLInputElement).click();
}

async function handleAudioFileSelected(file: File) {
  try {
    if (!audioContext) audioContext = new AudioContext();
    const arrayBuf = await file.arrayBuffer();
    audioBuffer = await audioContext.decodeAudioData(arrayBuf);
    loadedAudioName = file.name;
    $('audio-filename').textContent = file.name;
    audioPauseOffset = 0;

    ($('audio-eject-btn') as HTMLButtonElement).disabled = false;
    ($('audio-play-btn') as HTMLButtonElement).disabled = false;
    $('audio-load-btn').classList.add('active');

    log(`Audio loaded: ${file.name} (${audioBuffer.duration.toFixed(1)}s)`, 'success');
  } catch (err: any) {
    log(`Failed to load audio: ${err.message || err}`, 'error');
  }
}

function ejectAudio() {
  stopAudio();
  audioBuffer = null;
  loadedAudioName = '';
  $('audio-filename').textContent = '';
  ($('audio-eject-btn') as HTMLButtonElement).disabled = true;
  ($('audio-play-btn') as HTMLButtonElement).disabled = true;
  $('audio-load-btn').classList.remove('active');
  log('Audio ejected.', 'warn');
}

function toggleAudioPlayback() {
  if (audioIsPlaying) stopAudio();
  else playAudio();
}

function playAudio() {
  if (!audioContext || !audioBuffer) return;
  if (audioContext.state === 'suspended') audioContext.resume();

  audioSource = audioContext.createBufferSource();
  audioSource.buffer = audioBuffer;
  audioSource.connect(audioContext.destination);
  audioSource.onended = () => {
    if (audioIsPlaying) {
      audioIsPlaying = false;
      audioPauseOffset = 0;
      updateAudioUI();
      log('Audio playback finished.', 'info');
    }
  };
  audioSource.start(0, audioPauseOffset);
  audioStartTime = audioContext.currentTime - audioPauseOffset;
  audioIsPlaying = true;
  updateAudioUI();
  log(`Playing: ${loadedAudioName}`, 'info');
}

function stopAudio() {
  if (audioSource) {
    try {
      audioSource.onended = null;
      audioSource.stop();
    } catch { /* already stopped */ }
    audioSource = null;
  }
  if (audioIsPlaying && audioContext) {
    audioPauseOffset = audioContext.currentTime - audioStartTime;
  }
  audioIsPlaying = false;
  updateAudioUI();
}

function updateAudioUI() {
  // Guard against DOM being gone (React unmount during teardown)
  const playIcon = document.getElementById('play-icon') as unknown as SVGElement | null;
  const pauseIcon = document.getElementById('pause-icon') as unknown as SVGElement | null;
  const label = document.getElementById('audio-play-label');
  const btn = document.getElementById('audio-play-btn');
  if (!playIcon || !pauseIcon || !label || !btn) return;
  label.textContent = audioIsPlaying ? 'Pause' : 'Play';
  playIcon.style.display = audioIsPlaying ? 'none' : '';
  pauseIcon.style.display = audioIsPlaying ? '' : 'none';
  btn.classList.toggle('active', audioIsPlaying);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function initMonitor() {
  $ = (id: string) => document.getElementById(id)!;
  canvas = $('eeg-canvas') as HTMLCanvasElement;
  ctx = canvas.getContext('2d')!;

  if (!navigator.bluetooth) {
    log('Web Bluetooth not supported in this browser!', 'error');
    log('Please use Chrome or Edge on desktop.', 'error');
    ($('connect-btn') as HTMLButtonElement).disabled = true;
    return;
  }

  resizeCanvas();
  resizeHandler = resizeCanvas;
  window.addEventListener('resize', resizeHandler);

  $('connect-btn').addEventListener('click', connect);

  // Export controls
  const exportBtn = $('export-btn');
  const exportDropdown = $('export-dropdown');
  exportBtn.addEventListener('click', toggleExportDropdown);
  exportDropdown.querySelectorAll('.export-option').forEach((opt) => {
    opt.addEventListener('click', () => {
      const sec = parseInt((opt as HTMLButtonElement).dataset.seconds || '0');
      exportSessionData(sec);
    });
  });

  outsideClickHandler = (e: MouseEvent) => {
    if (!exportBtn.contains(e.target as Node) && !exportDropdown.contains(e.target as Node)) {
      exportDropdown.classList.remove('open');
    }
  };
  document.addEventListener('click', outsideClickHandler);

  // Audio controls
  $('audio-load-btn').addEventListener('click', loadAudioFile);
  $('audio-eject-btn').addEventListener('click', ejectAudio);
  $('audio-play-btn').addEventListener('click', toggleAudioPlayback);
  ($('audio-file-input') as HTMLInputElement).addEventListener('change', () => {
    const input = $('audio-file-input') as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handleAudioFileSelected(file);
    input.value = '';
  });

  log('Web Bluetooth API detected. Ready to connect.', 'success');

  animFrameId = requestAnimationFrame(animate);
}

export function destroyMonitor() {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (resizeHandler) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler);
    outsideClickHandler = null;
  }
  stopAudio();
}
