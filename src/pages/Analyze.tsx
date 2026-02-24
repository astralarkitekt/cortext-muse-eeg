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
const DEFAULT_SETTLE_SECONDS = 10; // default trim for signal settling
const AUTO_PP_THRESHOLD = 35;   // µV peak-to-peak threshold for "settled"
const AUTO_CONSEC_EPOCHS = 10;  // consecutive 1-second epochs below threshold

type TrimMode = 'auto' | 'manual';

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

function parseCSV(text: string, filename: string, settleSeconds: number = DEFAULT_SETTLE_SECONDS): ParsedSession {
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
  const settleCutoff = sessionStartTs + settleSeconds * 1000;
  const packets = settleSeconds > 0
    ? allPackets.filter((p) => p.timestamp >= settleCutoff)
    : [...allPackets];
  const actualTrimmed = packets.length > 0 && settleSeconds > 0
    ? (Math.min(...packets.map((p) => p.timestamp)) - sessionStartTs) / 1000
    : 0;

  if (packets.length === 0) throw new Error(`All data falls within the ${settleSeconds}s settle period — need a longer recording or reduce the trim`);

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

// ─── Auto-detect settle point ────────────────────────────────────────────────

/**
 * Scan raw packets epoch-by-epoch (1 s windows). For each epoch, compute the
 * average Peak-to-Peak across all channels. The signal is considered "settled"
 * once P2P stays below `ppThreshold` µV for `requiredEpochs` consecutive epochs.
 * Returns the number of seconds to trim, or `DEFAULT_SETTLE_SECONDS` as fallback.
 */
function autoDetectSettle(
  allPackets: EEGPacket[],
  ppThreshold = AUTO_PP_THRESHOLD,
  requiredEpochs = AUTO_CONSEC_EPOCHS,
): number {
  if (allPackets.length === 0) return DEFAULT_SETTLE_SECONDS;

  const sessionStart = Math.min(...allPackets.map((p) => p.timestamp));
  const sessionEnd = Math.max(...allPackets.map((p) => p.timestamp));
  const totalEpochs = Math.floor((sessionEnd - sessionStart) / 1000);

  let consecutiveBelow = 0;

  for (let e = 0; e < totalEpochs; e++) {
    const winStart = sessionStart + e * 1000;
    const winEnd = winStart + 1000;
    const inWindow = allPackets.filter((p) => p.timestamp >= winStart && p.timestamp < winEnd);

    if (inWindow.length === 0) {
      consecutiveBelow = 0; // gap in data — reset
      continue;
    }

    // Average peak-to-peak across packets in this epoch
    const avgPP = inWindow.reduce((s, p) => s + p.peakToPeak, 0) / inWindow.length;

    if (avgPP < ppThreshold) {
      consecutiveBelow++;
      if (consecutiveBelow >= requiredEpochs) {
        // The settle point is where the first of these consecutive quiet epochs began
        const settleEnd = e + 1 - requiredEpochs; // epoch index where the quiet run started
        return Math.max(0, settleEnd); // seconds to trim
      }
    } else {
      consecutiveBelow = 0;
    }
  }

  // Never settled — fall back to default (the data might all be noisy)
  return DEFAULT_SETTLE_SECONDS;
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

// ─── Markdown Report ─────────────────────────────────────────────────────────

function generateMarkdownReport(
  session: ParsedSession,
  bandTimeline: BandTimePoint[],
  avgBands: { band: string; power: number; label: string; color: string }[],
  overallQuality: { meanAmp: number; peakToPeak: number; rms: number } | null,
  signalQuality: SignalQualityPoint[],
  trimMode: TrimMode = 'manual',
): string {
  const dominant = avgBands.length
    ? avgBands.reduce((a, b) => (a.power > b.power ? a : b))
    : null;

  const lines: string[] = [];
  const ln = (s = '') => lines.push(s);

  ln('# CORTEX EEG Analysis Report');
  ln();
  ln(`> Generated by CORTEX v0.2.0 — ${new Date().toISOString()}`);
  ln();

  // ─── Session metadata
  ln('## Session Metadata');
  ln();
  ln('| Property | Value |');
  ln('|----------|-------|');
  ln(`| Source file | \`${session.filename}\` |`);
  ln(`| Channels | ${session.channels.join(', ')} |`);
  ln(`| Total packets | ${session.packets.length.toLocaleString()} |`);
  ln(`| Total samples | ${session.totalSamples.toLocaleString()} |`);
  ln(`| Duration (post-trim) | ${formatDuration(session.durationMs)} |`);
  ln(`| Settle trim | ${session.trimmedSeconds}s removed from start (${trimMode === 'auto' ? `auto-detected — P2P < ${AUTO_PP_THRESHOLD} µV for ${AUTO_CONSEC_EPOCHS} epochs` : 'manual'}) |`);
  ln(`| Sample rate | ${EEG_SAMPLE_RATE} Hz |`);
  ln(`| FFT window | ${FFT_WINDOW} samples |`);
  ln();

  // ─── Band Power Summary
  ln('## Band Power Summary');
  ln();
  if (dominant) {
    ln(`**Dominant band:** ${dominant.band} (${dominant.power.toFixed(1)} dB µV²)`);
    ln();
  }
  ln('| Band | Frequency Range | Power (dB µV²) |');
  ln('|------|-----------------|-----------------|');
  for (const b of avgBands) {
    const marker = b === dominant ? ' ◀ dominant' : '';
    ln(`| ${b.band} | ${BAND_LABELS[b.band].replace(/^[^ ]+ /, '')} | ${b.power.toFixed(1)}${marker} |`);
  }
  ln();

  // Interpretation hints
  ln('### Band Interpretation Guide');
  ln();
  ln('- **Delta (0.5–4 Hz):** Deep sleep, unconscious processes. High delta in waking state may indicate artifact or drowsiness.');
  ln('- **Theta (4–8 Hz):** Drowsiness, light sleep, meditative states, memory encoding. Elevated theta with eyes closed suggests relaxation.');
  ln('- **Alpha (8–13 Hz):** Relaxed wakefulness, eyes-closed rest. Strong alpha with eyes closed is normal. Suppressed alpha may indicate cognitive engagement or anxiety.');
  ln('- **Beta (13–30 Hz):** Active thinking, focus, alertness. High beta may indicate concentration or anxiety/stress.');
  ln('- **Gamma (30–100 Hz):** Higher-order cognitive processing, cross-modal binding. Often contaminated by muscle artifact (EMG).');
  ln();

  // ─── Signal Quality
  ln('## Signal Quality');
  ln();
  if (overallQuality) {
    ln('| Metric | Value | Unit | Typical Range |');
    ln('|--------|-------|------|---------------|');
    ln(`| Mean Amplitude | ${overallQuality.meanAmp.toFixed(2)} | µV | 10–50 µV (good) |`);
    ln(`| Peak-to-Peak | ${overallQuality.peakToPeak.toFixed(2)} | µV | 20–100 µV (artifact-free) |`);
    ln(`| RMS Power | ${overallQuality.rms.toFixed(2)} | µV | 10–50 µV (clean signal) |`);
    ln();

    // Quality assessment
    const meanOk = overallQuality.meanAmp >= 5 && overallQuality.meanAmp <= 100;
    const p2pOk = overallQuality.peakToPeak <= 200;
    const rmsOk = overallQuality.rms >= 5 && overallQuality.rms <= 100;
    const qualityScore = [meanOk, p2pOk, rmsOk].filter(Boolean).length;
    const qualityLabel = qualityScore === 3 ? 'Good' : qualityScore >= 2 ? 'Acceptable' : 'Poor';
    ln(`**Overall signal quality assessment:** ${qualityLabel} (${qualityScore}/3 metrics within expected range)`);
    ln();
  }

  // ─── Per-Channel Statistics
  ln('## Per-Channel Statistics');
  ln();
  for (const ch of session.channels) {
    const chPackets = session.packets.filter((p) => p.channel === ch);
    if (chPackets.length === 0) continue;

    const allSamples = chPackets.flatMap((p) => p.samples);
    const mean = allSamples.reduce((a, b) => a + b, 0) / allSamples.length;
    const meanAbs = allSamples.reduce((a, b) => a + Math.abs(b), 0) / allSamples.length;
    const min = Math.min(...allSamples);
    const max = Math.max(...allSamples);
    const rms = Math.sqrt(allSamples.reduce((a, b) => a + b * b, 0) / allSamples.length);
    const variance = allSamples.reduce((a, b) => a + (b - mean) ** 2, 0) / allSamples.length;
    const stdDev = Math.sqrt(variance);

    ln(`### ${ch}`);
    ln();
    ln('| Metric | Value |');
    ln('|--------|-------|');
    ln(`| Packets | ${chPackets.length} |`);
    ln(`| Samples | ${allSamples.length} |`);
    ln(`| Mean | ${mean.toFixed(2)} µV |`);
    ln(`| Mean Absolute | ${meanAbs.toFixed(2)} µV |`);
    ln(`| Min | ${min.toFixed(2)} µV |`);
    ln(`| Max | ${max.toFixed(2)} µV |`);
    ln(`| Peak-to-Peak | ${(max - min).toFixed(2)} µV |`);
    ln(`| RMS | ${rms.toFixed(2)} µV |`);
    ln(`| Std Dev | ${stdDev.toFixed(2)} µV |`);
    ln();
  }

  // ─── Band Power Timeline (sampled for AI readability)
  ln('## Band Power Timeline');
  ln();
  ln('One-second windowed band powers (dB µV²), averaged across channels.');
  ln();
  if (bandTimeline.length > 0) {
    // Sample to ~20 rows for readability
    const step = Math.max(1, Math.floor(bandTimeline.length / 20));
    ln('| Time | Delta | Theta | Alpha | Beta | Gamma |');
    ln('|------|-------|-------|-------|------|-------|');
    for (let i = 0; i < bandTimeline.length; i += step) {
      const t = bandTimeline[i];
      ln(`| ${formatTime(t.time)} | ${t.delta.toFixed(1)} | ${t.theta.toFixed(1)} | ${t.alpha.toFixed(1)} | ${t.beta.toFixed(1)} | ${t.gamma.toFixed(1)} |`);
    }
    // Always include last point
    const last = bandTimeline[bandTimeline.length - 1];
    if (bandTimeline.length % step !== 1) {
      ln(`| ${formatTime(last.time)} | ${last.delta.toFixed(1)} | ${last.theta.toFixed(1)} | ${last.alpha.toFixed(1)} | ${last.beta.toFixed(1)} | ${last.gamma.toFixed(1)} |`);
    }
    ln();
  }

  // ─── Signal Quality Timeline (sampled)
  ln('## Signal Quality Timeline');
  ln();
  if (signalQuality.length > 0) {
    const step = Math.max(1, Math.floor(signalQuality.length / 20));
    ln('| Time | Mean Amp (µV) | Peak-Peak (µV) | RMS (µV) |');
    ln('|------|---------------|----------------|----------|');
    for (let i = 0; i < signalQuality.length; i += step) {
      const q = signalQuality[i];
      ln(`| ${formatTime(q.time)} | ${q.meanAmp.toFixed(2)} | ${q.peakToPeak.toFixed(2)} | ${q.rms.toFixed(2)} |`);
    }
    const last = signalQuality[signalQuality.length - 1];
    if (signalQuality.length % step !== 1) {
      ln(`| ${formatTime(last.time)} | ${last.meanAmp.toFixed(2)} | ${last.peakToPeak.toFixed(2)} | ${last.rms.toFixed(2)} |`);
    }
    ln();
  }

  // ─── Trend analysis
  ln('## Trend Analysis');
  ln();
  if (bandTimeline.length >= 4) {
    const half = Math.floor(bandTimeline.length / 2);
    const firstHalf = bandTimeline.slice(0, half);
    const secondHalf = bandTimeline.slice(half);

    const avgFirst = (band: keyof BandTimePoint) =>
      firstHalf.reduce((s, t) => s + (t[band] as number), 0) / firstHalf.length;
    const avgSecond = (band: keyof BandTimePoint) =>
      secondHalf.reduce((s, t) => s + (t[band] as number), 0) / secondHalf.length;

    ln('Comparison of first half vs. second half of session:');
    ln();
    ln('| Band | First Half (dB) | Second Half (dB) | Change |');
    ln('|------|-----------------|------------------|--------|');
    for (const band of ['delta', 'theta', 'alpha', 'beta', 'gamma'] as const) {
      const f = avgFirst(band);
      const s = avgSecond(band);
      const diff = s - f;
      const arrow = diff > 0.5 ? '↑' : diff < -0.5 ? '↓' : '→';
      ln(`| ${band} | ${f.toFixed(1)} | ${s.toFixed(1)} | ${arrow} ${diff > 0 ? '+' : ''}${diff.toFixed(1)} |`);
    }
    ln();
  } else {
    ln('_Insufficient data for trend analysis (need at least 4 seconds)._');
    ln();
  }

  // ─── Analysis notes for AI
  ln('## Notes for AI Analysis');
  ln();
  ln('- All power values are in dB µV² (10 · log10(power × 1e6)).');
  ln('- The Muse 2 has 4 EEG channels: TP9 (left ear), AF7 (left forehead), AF8 (right forehead), TP10 (right ear).');
  ln('- Temporal channels (TP9/TP10) are more susceptible to jaw clench and muscle artifacts.');
  ln('- Frontal channels (AF7/AF8) are better for attention/meditation detection but more susceptible to eye blink artifacts.');
  ln(`- The first ${session.trimmedSeconds} seconds of the recording were trimmed to allow the signal to settle after electrode contact (${trimMode === 'auto' ? `auto-detected: average peak-to-peak dropped below ${AUTO_PP_THRESHOLD} µV for ${AUTO_CONSEC_EPOCHS} consecutive 1-second epochs` : 'manual setting'}).`);
  ln('- Band powers are averaged across all available channels within each 1-second window.');
  ln('- The sample rate is 256 Hz with a 256-sample FFT window (1 second per window, 1 Hz frequency resolution).');
  ln('- Consider the signal quality metrics when interpreting results — high peak-to-peak values (>200 µV) suggest artifact contamination.');
  ln();
  ln('---');
  ln(`*Report generated from CORTEX EEG monitoring system*`);

  return lines.join('\n');
}

function downloadMarkdown(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Analyze() {
  const [session, setSession] = useState<ParsedSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragover, setDragover] = useState(false);
  const [settleSeconds, setSettleSeconds] = useState(DEFAULT_SETTLE_SECONDS);
  const [trimMode, setTrimMode] = useState<TrimMode>('auto');
  const [rawCsv, setRawCsv] = useState<{ text: string; name: string } | null>(null);
  // Stash raw parsed packets (pre-trim) for auto-detect without re-splitting CSV
  const allPacketsRef = useRef<EEGPacket[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse raw CSV text into allPackets (no trim) — cached for auto-detect
  const parseRawPackets = useCallback((text: string): EEGPacket[] => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const header = lines[0].split(',');
    const tsIdx = header.indexOf('timestamp_ms');
    const chIdx = header.indexOf('channel');
    if (tsIdx === -1 || chIdx === -1) return [];
    const sampleCols = header.slice(2).length;
    const packets: EEGPacket[] = [];
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
        const meanAmp = samples.reduce((a, b) => a + Math.abs(b), 0) / samples.length;
        const peakToPeak = Math.max(...samples) - Math.min(...samples);
        const rms = Math.sqrt(samples.reduce((a, b) => a + b * b, 0) / samples.length);
        packets.push({ timestamp, channel, samples, meanAmp, peakToPeak, rms });
      }
    }
    return packets;
  }, []);

  // Re-parse when settle seconds changes
  const reparseWithSettle = useCallback((text: string, name: string, settle: number) => {
    try {
      const parsed = parseCSV(text, name, settle);
      setSession(parsed);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to parse CSV');
      setSession(null);
    }
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      setRawCsv({ text, name: file.name });

      // Pre-parse raw packets for auto-detect
      const rawPackets = parseRawPackets(text);
      allPacketsRef.current = rawPackets;

      // Auto-detect settle on load
      const autoSettle = autoDetectSettle(rawPackets);
      setSettleSeconds(autoSettle);
      setTrimMode('auto');
      reparseWithSettle(text, file.name, autoSettle);
    } catch (err: any) {
      setError(err.message || 'Failed to parse CSV');
      setSession(null);
    }
  }, [parseRawPackets, reparseWithSettle]);

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
              <span className="file-info-stat file-info-settle" style={{ color: 'var(--accent-beta)' }}>
                <button
                  className={`settle-mode-btn ${trimMode === 'auto' ? 'active' : ''}`}
                  title={`Auto-detect: trims when P2P < ${AUTO_PP_THRESHOLD} µV for ${AUTO_CONSEC_EPOCHS} consecutive epochs`}
                  onClick={() => {
                    if (trimMode !== 'auto' && allPacketsRef.current.length > 0) {
                      const autoSettle = autoDetectSettle(allPacketsRef.current);
                      setSettleSeconds(autoSettle);
                      setTrimMode('auto');
                      if (rawCsv) reparseWithSettle(rawCsv.text, rawCsv.name, autoSettle);
                    }
                  }}
                >auto</button>
                <input
                  type="number"
                  className="settle-input"
                  min={0}
                  max={120}
                  value={settleSeconds}
                  onChange={(e) => {
                    const val = Math.max(0, Math.min(120, parseInt(e.target.value) || 0));
                    setSettleSeconds(val);
                    setTrimMode('manual');
                    if (rawCsv) reparseWithSettle(rawCsv.text, rawCsv.name, val);
                  }}
                />
                s trim
              </span>
            </div>
            <button
              className="file-info-close"
              style={{ backgroundColor: 'var(--accent-alpha)', color: '#000' }}
              onClick={() => {
                if (!session) return;
                const md = generateMarkdownReport(session, bandTimeline, avgBands, overallQuality, signalQuality, trimMode);
                const name = session.filename.replace(/\.csv$/i, '') + '-report.md';
                downloadMarkdown(md, name);
              }}
            >
              Export Report
            </button>
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
                      <Area type="monotone" dataKey="delta" stroke={BAND_COLORS.delta} fill={BAND_COLORS.delta} fillOpacity={0.15} strokeWidth={1.5} name="δ Delta" />
                      <Area type="monotone" dataKey="theta" stroke={BAND_COLORS.theta} fill={BAND_COLORS.theta} fillOpacity={0.15} strokeWidth={1.5} name="θ Theta" />
                      <Area type="monotone" dataKey="alpha" stroke={BAND_COLORS.alpha} fill={BAND_COLORS.alpha} fillOpacity={0.15} strokeWidth={1.5} name="α Alpha" />
                      <Area type="monotone" dataKey="beta" stroke={BAND_COLORS.beta} fill={BAND_COLORS.beta} fillOpacity={0.15} strokeWidth={1.5} name="β Beta" />
                      <Area type="monotone" dataKey="gamma" stroke={BAND_COLORS.gamma} fill={BAND_COLORS.gamma} fillOpacity={0.15} strokeWidth={1.5} name="γ Gamma" />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="chart-empty">Insufficient data for band analysis</div>
                )}
              </div>
            </div>

            {/* Average Band Power */}
            <div className="panel chart-panel">
              <div className="panel-header">
                <span className="panel-title">Average Band Power</span>
              </div>
              <div className="panel-body">
                {avgBands.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={avgBands} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" horizontal={false} />
                      <XAxis type="number" stroke="#555570" fontSize={10} />
                      <YAxis dataKey="band" type="category" stroke="#555570" fontSize={10} width={50} />
                      <Tooltip content={<CortexTooltip />} />
                      <Bar
                        dataKey="power"
                        name="Power (dB µV²)"
                        radius={[0, 4, 4, 0]}
                        barSize={20}
                        fill="#22d3ee"
                        // Use per-bar colors
                        label={false}
                      >
                        {avgBands.map((entry, index) => (
                          <rect key={index} fill={entry.color} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="chart-empty">No data</div>
                )}
              </div>
            </div>

            {/* Signal Quality Timeline */}
            <div className="panel chart-panel">
              <div className="panel-header">
                <span className="panel-title">Signal Quality</span>
              </div>
              <div className="panel-body">
                {signalQuality.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={signalQuality}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                      <XAxis dataKey="time" tickFormatter={formatTime} stroke="#555570" fontSize={10} />
                      <YAxis stroke="#555570" fontSize={10} label={{ value: 'µV', angle: -90, position: 'insideLeft', style: { fill: '#555570', fontSize: 10 } }} />
                      <Tooltip content={<CortexTooltip />} />
                      <Legend wrapperStyle={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }} />
                      <Line type="monotone" dataKey="meanAmp" stroke="#22d3ee" strokeWidth={1.5} dot={false} name="Mean Amplitude" />
                      <Line type="monotone" dataKey="peakToPeak" stroke="#34d399" strokeWidth={1.5} dot={false} name="Peak-to-Peak" />
                      <Line type="monotone" dataKey="rms" stroke="#818cf8" strokeWidth={1.5} dot={false} name="RMS Power" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="chart-empty">Insufficient data</div>
                )}
              </div>
            </div>

            {/* Raw Waveform (downsampled) */}
            <div className="panel chart-panel full-width">
              <div className="panel-header">
                <span className="panel-title">Raw EEG Waveform</span>
              </div>
              <div className="panel-body">
                {waveformData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={waveformData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                      <XAxis dataKey="time" tickFormatter={formatTime} stroke="#555570" fontSize={10} />
                      <YAxis stroke="#555570" fontSize={10} label={{ value: 'µV', angle: -90, position: 'insideLeft', style: { fill: '#555570', fontSize: 10 } }} />
                      <Tooltip content={<CortexTooltip />} />
                      <Legend wrapperStyle={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }} />
                      {session.channels.map((ch) => (
                        <Line
                          key={ch}
                          type="monotone"
                          dataKey={ch}
                          stroke={CHANNEL_COLORS[ch]}
                          strokeWidth={1}
                          dot={false}
                          name={ch}
                          opacity={0.8}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="chart-empty">No waveform data</div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={onFileInput}
      />
    </div>
  );
}
