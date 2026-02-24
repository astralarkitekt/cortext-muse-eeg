import { useState, useCallback, useRef, useMemo } from 'react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import { extractBandPowers, type BandPowers } from '../signal';

// ─── Types ───────────────────────────────────────────────────────────────────

interface EEGPacket {
  timestamp: number;
  channel: string;
  samples: number[];
  // Per-packet signal quality (computed on parse)
  meanAmp: number;
  peakToPeak: number;
  rms: number;
}

interface ParsedSession {
  filename: string;
  packets: EEGPacket[];
  channels: string[];
  durationMs: number;
  totalSamples: number;
  trimmedSeconds: number; // how many seconds were trimmed from start
}

interface BandTimePoint {
  time: number;
  timeLabel: string;
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

interface ChannelWaveformPoint {
  time: number;
  TP9?: number;
  AF7?: number;
  AF8?: number;
  TP10?: number;
}

interface SignalQualityPoint {
  time: number;
  meanAmp: number;
  peakToPeak: number;
  rms: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_NAMES = ['TP9', 'AF7', 'AF8', 'TP10'];
const EEG_SAMPLE_RATE = 256;
const FFT_WINDOW = 256;
const SETTLE_SECONDS = 10; // trim first N seconds for signal settling

const BAND_COLORS: Record<string, string> = {
  delta: '#4a6cf7',
  theta: '#22d3ee',
  alpha: '#10b981',
  beta: '#f59e0b',
  gamma: '#ef4444',
};

const CHANNEL_COLORS: Record<string, string> = {
  TP9: '#818cf8',
  AF7: '#22d3ee',
  AF8: '#34d399',
  TP10: '#fbbf24',
};

const BAND_LABELS: Record<string, string> = {
  delta: 'δ Delta (0.5–4 Hz)',
  theta: 'θ Theta (4–8 Hz)',
  alpha: 'α Alpha (8–13 Hz)',
  beta: 'β Beta (13–30 Hz)',
  gamma: 'γ Gamma (30–100 Hz)',
};

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function parseCSV(text: string, filename: string): ParsedSession {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('CSV file is empty or has no data rows');

  const header = lines[0].split(',');
  const tsIdx = header.indexOf('timestamp_ms');
  const chIdx = header.indexOf('channel');

  if (tsIdx === -1 || chIdx === -1) {
    throw new Error('Invalid CSV format: missing timestamp_ms or channel columns');
  }

  const sampleCols = header.slice(2).length;
  const allPackets: EEGPacket[] = [];
  const channelSet = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 3) continue;

    const timestamp = parseInt(cols[tsIdx]);
    const channel = cols[chIdx];
    const samples: number[] = [];

    for (let j = 2; j < Math.min(cols.length, 2 + sampleCols); j++) {
      const v = parseFloat(cols[j]);
      if (!isNaN(v)) samples.push(v);
    }

    if (samples.length > 0) {
      // Compute per-packet signal quality metrics
      const meanAmp = samples.reduce((a, b) => a + Math.abs(b), 0) / samples.length;
      const peakToPeak = Math.max(...samples) - Math.min(...samples);
      const rms = Math.sqrt(samples.reduce((a, b) => a + b * b, 0) / samples.length);

      allPackets.push({ timestamp, channel, samples, meanAmp, peakToPeak, rms });
      channelSet.add(channel);
    }
  }

  if (allPackets.length === 0) throw new Error('No valid data packets found in CSV');

  // Trim settle period from the start
  const sessionStartTs = Math.min(...allPackets.map((p) => p.timestamp));
  const settleCutoff = sessionStartTs + SETTLE_SECONDS * 1000;
  const packets = allPackets.filter((p) => p.timestamp >= settleCutoff);
  const actualTrimmed = packets.length > 0
    ? (Math.min(...packets.map((p) => p.timestamp)) - sessionStartTs) / 1000
    : 0;

  if (packets.length === 0) throw new Error(`All data falls within the ${SETTLE_SECONDS}s settle period — need a longer recording`);

  const channels = CHANNEL_NAMES.filter((c) => channelSet.has(c));
  const minTs = Math.min(...packets.map((p) => p.timestamp));
  const maxTs = Math.max(...packets.map((p) => p.timestamp));
  const totalSamples = packets.reduce((s, p) => s + p.samples.length, 0);

  return {
    filename,
    packets,
    channels,
    durationMs: maxTs - minTs,
    totalSamples,
    trimmedSeconds: Math.round(actualTrimmed),
  };
}

// ─── Analysis Functions ──────────────────────────────────────────────────────

function computeBandTimeline(session: ParsedSession): BandTimePoint[] {
  const startTs = session.packets[0].timestamp;
  // Group packets into 1-second windows
  const windowMs = 1000;
  const duration = session.durationMs;
  const numWindows = Math.max(1, Math.floor(duration / windowMs));

  const timeline: BandTimePoint[] = [];

  for (let w = 0; w < numWindows; w++) {
    const winStart = startTs + w * windowMs;
    const winEnd = winStart + windowMs;

    // Collect all samples per channel in this window
    const channelSamples: Record<string, number[]> = {};
    for (const ch of session.channels) channelSamples[ch] = [];

    for (const p of session.packets) {
      if (p.timestamp >= winStart && p.timestamp < winEnd && channelSamples[p.channel]) {
        channelSamples[p.channel].push(...p.samples);
      }
    }

    // Compute band powers averaged across channels with enough samples
    const allBands: BandPowers[] = [];
    for (const ch of session.channels) {
      const s = channelSamples[ch];
      if (s.length >= FFT_WINDOW) {
        const arr = new Float64Array(s.slice(0, FFT_WINDOW));
        allBands.push(extractBandPowers(arr, EEG_SAMPLE_RATE));
      }
    }

    if (allBands.length > 0) {
      const avg: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
      for (const b of allBands) {
        for (const k of Object.keys(avg) as (keyof BandPowers)[]) {
          avg[k] += b[k] / allBands.length;
        }
      }

      const timeSec = (w * windowMs) / 1000;
      timeline.push({
        time: timeSec,
        timeLabel: formatTime(timeSec),
        delta: toDb(avg.delta),
        theta: toDb(avg.theta),
        alpha: toDb(avg.alpha),
        beta: toDb(avg.beta),
        gamma: toDb(avg.gamma),
      });
    }
  }

  return timeline;
}

function computeAverageBands(session: ParsedSession): { band: string; power: number; label: string; color: string }[] {
  // Collect all samples per channel
  const channelSamples: Record<string, number[]> = {};
  for (const ch of session.channels) channelSamples[ch] = [];
  for (const p of session.packets) {
    if (channelSamples[p.channel]) {
      channelSamples[p.channel].push(...p.samples);
    }
  }

  const allBands: BandPowers[] = [];
  for (const ch of session.channels) {
    const s = channelSamples[ch];
    // Process in 1-second windows
    for (let i = 0; i + FFT_WINDOW <= s.length; i += FFT_WINDOW) {
      const arr = new Float64Array(s.slice(i, i + FFT_WINDOW));
      allBands.push(extractBandPowers(arr, EEG_SAMPLE_RATE));
    }
  }

  if (allBands.length === 0) return [];

  const avg: BandPowers = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  for (const b of allBands) {
    for (const k of Object.keys(avg) as (keyof BandPowers)[]) {
      avg[k] += b[k] / allBands.length;
    }
  }

  return (Object.keys(avg) as (keyof BandPowers)[]).map((k) => ({
    band: k,
    power: toDb(avg[k]),
    label: BAND_LABELS[k],
    color: BAND_COLORS[k],
  }));
}

function downsampleWaveform(session: ParsedSession, maxPoints: number = 2000): ChannelWaveformPoint[] {
  // Reconstruct per-channel time series
  const channelData: Record<string, { time: number; value: number }[]> = {};
  for (const ch of session.channels) channelData[ch] = [];

  const startTs = session.packets[0].timestamp;

  for (const p of session.packets) {
    const baseTime = (p.timestamp - startTs) / 1000;
    const dt = 1 / EEG_SAMPLE_RATE;
    for (let i = 0; i < p.samples.length; i++) {
      channelData[p.channel]?.push({
        time: baseTime + i * dt,
        value: p.samples[i],
      });
    }
  }

  // Find the channel with most data for the timeline reference
  const refChannel = session.channels.reduce((best, ch) =>
    channelData[ch].length > channelData[best].length ? ch : best
  , session.channels[0]);

  const totalPoints = channelData[refChannel].length;
  const step = Math.max(1, Math.floor(totalPoints / maxPoints));

  const result: ChannelWaveformPoint[] = [];
  for (let i = 0; i < totalPoints; i += step) {
    const point: ChannelWaveformPoint = { time: channelData[refChannel][i].time };
    for (const ch of session.channels) {
      if (channelData[ch][i]) {
        (point as any)[ch] = channelData[ch][i].value;
      }
    }
    result.push(point);
  }

  return result;
}

function computeSignalQuality(session: ParsedSession): SignalQualityPoint[] {
  const startTs = session.packets[0].timestamp;
  const windowMs = 1000;
  const duration = session.durationMs;
  const numWindows = Math.max(1, Math.floor(duration / windowMs));

  const timeline: SignalQualityPoint[] = [];

  for (let w = 0; w < numWindows; w++) {
    const winStart = startTs + w * windowMs;
    const winEnd = winStart + windowMs;

    const windowPackets = session.packets.filter(
      (p) => p.timestamp >= winStart && p.timestamp < winEnd
    );

    if (windowPackets.length === 0) continue;

    const avgMean = windowPackets.reduce((s, p) => s + p.meanAmp, 0) / windowPackets.length;
    const avgP2P = windowPackets.reduce((s, p) => s + p.peakToPeak, 0) / windowPackets.length;
    const avgRms = windowPackets.reduce((s, p) => s + p.rms, 0) / windowPackets.length;

    timeline.push({
      time: (w * windowMs) / 1000,
      meanAmp: parseFloat(avgMean.toFixed(2)),
      peakToPeak: parseFloat(avgP2P.toFixed(2)),
      rms: parseFloat(avgRms.toFixed(2)),
    });
  }

  return timeline;
}

function computeOverallSignalQuality(session: ParsedSession) {
  const packets = session.packets;
  if (packets.length === 0) return null;
  return {
    meanAmp: parseFloat((packets.reduce((s, p) => s + p.meanAmp, 0) / packets.length).toFixed(2)),
    peakToPeak: parseFloat((packets.reduce((s, p) => s + p.peakToPeak, 0) / packets.length).toFixed(2)),
    rms: parseFloat((packets.reduce((s, p) => s + p.rms, 0) / packets.length).toFixed(2)),
  };
}

function toDb(power: number): number {
  return power > 0 ? parseFloat((10 * Math.log10(power * 1e6)).toFixed(1)) : 0;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────────

function CortexTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <div className="label">{typeof label === 'number' ? formatTime(label) : label}</div>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="value" style={{ color: entry.color }}>
          {entry.name}: {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
        </div>
      ))}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Analyze() {
  const [session, setSession] = useState<ParsedSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragover, setDragover] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseCSV(text, file.name);
      setSession(parsed);
    } catch (err: any) {
      setError(err.message || 'Failed to parse CSV');
      setSession(null);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragover(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragover(true);
  }, []);

  const onDragLeave = useCallback(() => setDragover(false), []);

  const onFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = '';
  }, [handleFile]);

  // Memoized computations
  const bandTimeline = useMemo(() => session ? computeBandTimeline(session) : [], [session]);
  const avgBands = useMemo(() => session ? computeAverageBands(session) : [], [session]);
  const waveformData = useMemo(() => session ? downsampleWaveform(session) : [], [session]);
  const signalQuality = useMemo(() => session ? computeSignalQuality(session) : [], [session]);
  const overallQuality = useMemo(() => session ? computeOverallSignalQuality(session) : null, [session]);

  const summaryStats = useMemo(() => {
    if (!avgBands.length) return null;
    const dominant = avgBands.reduce((a, b) => a.power > b.power ? a : b);
    return { dominant };
  }, [avgBands]);

  return (
    <div className="analyze-page">
      {!session ? (
        <>
          <div
            className={`drop-zone${dragover ? ' dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
          >
            <div className="drop-zone-icon">
              <svg viewBox="0 0 24 24">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="12" y2="12" />
                <line x1="15" y1="15" x2="12" y2="12" />
              </svg>
            </div>
            <div className="drop-zone-text">DROP CSV FILE OR CLICK TO BROWSE</div>
            <div className="drop-zone-hint">Accepts Cortex EEG export files (.csv)</div>
          </div>
          {error && (
            <div className="panel" style={{ borderColor: 'var(--accent-gamma)' }}>
              <div className="panel-body" style={{ color: 'var(--accent-gamma)', fontFamily: 'var(--mono)', fontSize: '12px' }}>
                {error}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* File info bar */}
          <div className="file-info-bar">
            <div className="file-info-details">
              <span className="file-info-name">{session.filename}</span>
              <span className="file-info-stat">{session.channels.length} channels</span>
              <span className="file-info-stat">{session.totalSamples.toLocaleString()} samples</span>
              <span className="file-info-stat">{formatDuration(session.durationMs)}</span>
              <span className="file-info-stat">{session.packets.length.toLocaleString()} packets</span>
              <span className="file-info-stat" style={{ color: 'var(--accent-beta)' }}>{session.trimmedSeconds}s trimmed (settle)</span>
            </div>
            <button className="file-info-close" onClick={() => setSession(null)}>
              Close
            </button>
          </div>

          {/* Summary stats */}
          <div className="summary-grid">
            {avgBands.map((b) => (
              <div className="summary-card" key={b.band}>
                <div className="summary-card-value" style={{ color: b.color }}>{b.power.toFixed(1)}</div>
                <div className="summary-card-unit">dB µV²</div>
                <div className="summary-card-label">{b.band}</div>
              </div>
            ))}
          </div>

          {/* Signal quality summary */}
          {overallQuality && (
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <div className="summary-card">
                <div className="summary-card-value" style={{ color: 'var(--accent-theta)' }}>{overallQuality.meanAmp.toFixed(1)}</div>
                <div className="summary-card-unit">µV</div>
                <div className="summary-card-label">Mean Amp</div>
              </div>
              <div className="summary-card">
                <div className="summary-card-value" style={{ color: 'var(--channel-af8)' }}>{overallQuality.peakToPeak.toFixed(1)}</div>
                <div className="summary-card-unit">µV</div>
                <div className="summary-card-label">Peak-Peak</div>
              </div>
              <div className="summary-card">
                <div className="summary-card-value" style={{ color: 'var(--channel-tp9)' }}>{overallQuality.rms.toFixed(1)}</div>
                <div className="summary-card-unit">µV</div>
                <div className="summary-card-label">RMS Power</div>
              </div>
            </div>
          )}

          {/* Charts */}
          <div className="chart-grid">
            {/* Band Power Timeline */}
            <div className="panel chart-panel full-width">
              <div className="panel-header">
                <span className="panel-title">Band Power Over Time</span>
                {summaryStats && (
                  <span className="panel-title" style={{ color: BAND_COLORS[summaryStats.dominant.band] }}>
                    Dominant: {summaryStats.dominant.band}
                  </span>
                )}
              </div>
              <div className="panel-body">
                {bandTimeline.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <AreaChart data={bandTimeline}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                      <XAxis dataKey="time" tickFormatter={formatTime} stroke="#555570" fontSize={10} />
                      <YAxis stroke="#555570" fontSize={10} label={{ value: 'dB µV²', angle: -90, position: 'insideLeft', style: { fill: '#555570', fontSize: 10 } }} />
                      <Tooltip content={<CortexTooltip />} />
                      <Legend wrapperStyle={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }} />
                      <Area type="monotone" dataKey="delta" stroke={BAND_COLORS.delta} fill={BAND_COLORS.delta} fillOpacity={0.15} strokeWidt