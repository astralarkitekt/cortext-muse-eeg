import { useState, useEffect, useRef, useCallback } from 'react';
import NeuroEngine, {
  type NeuroState,
  type MappingSnapshot,
  type NormalizedBands,
  type SpikeEvent,
  type SessionStats,
} from '../lib/NeuroEngine';
import { onBandUpdate, getIsStreaming } from '../monitor-engine';

// ─── Constants ───────────────────────────────────────────────────────────────

const BAND_COLORS: Record<string, string> = {
  delta: '#4a6cf7',
  theta: '#22d3ee',
  alpha: '#10b981',
  beta: '#f59e0b',
  gamma: '#ef4444',
};

const BAND_LABELS: Record<string, string> = {
  delta: 'DEEP',
  theta: 'MEDITATIVE',
  alpha: 'RELAXED',
  beta: 'FOCUSED',
  gamma: 'PEAK',
};

// ─── Session Report Generator ────────────────────────────────────────────────

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function generateSessionReport(stats: SessionStats): string {
  const { spikeCounts, spikeLog, totalSpikes, elapsedSeconds, telemetry, calibration, sessionDuration } = stats;
  const date = new Date();
  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const durationStr = formatDuration(elapsedSeconds);
  const sessionType = sessionDuration > 0 ? `${formatDuration(sessionDuration)} timed session` : 'Open session';

  // Determine dominant state across session
  const bandTotals: Record<string, number> = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
  for (const t of telemetry) {
    for (const k of Object.keys(bandTotals)) {
      bandTotals[k] += t.bands[k as keyof NormalizedBands];
    }
  }
  let overallDominant = 'alpha';
  let maxTotal = -1;
  for (const [k, v] of Object.entries(bandTotals)) {
    if (v > maxTotal) { maxTotal = v; overallDominant = k; }
  }

  const spikeRate = elapsedSeconds > 0 ? (totalSpikes / (elapsedSeconds / 60)).toFixed(1) : '0';

  let report = `# 🧠 CORTEX Neurofeedback Session Report\n\n`;
  report += `**Date:** ${dateStr} at ${timeStr}  \n`;
  report += `**Session:** ${sessionType}  \n`;
  report += `**Duration:** ${durationStr}\n\n`;
  report += `---\n\n`;

  // Summary table
  report += `## Session Summary\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Duration | ${durationStr} |\n`;
  report += `| Total Spikes | ${totalSpikes} |\n`;
  report += `| Spike Rate | ${spikeRate} / min |\n`;
  report += `| Dominant State | ${BAND_LABELS[overallDominant] || 'IDLE'} (${overallDominant}) |\n`;
  report += `\n`;

  // Spike distribution
  report += `## Spike Distribution\n\n`;
  report += `| Band | Count | % |\n`;
  report += `|------|-------|---|\n`;
  const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
  for (const b of bands) {
    const count = spikeCounts[b] || 0;
    const pct = totalSpikes > 0 ? Math.round((count / totalSpikes) * 100) : 0;
    const symbol = { delta: 'δ', theta: 'θ', alpha: 'α', beta: 'β', gamma: 'γ' }[b] || b;
    report += `| ${symbol} ${b.charAt(0).toUpperCase() + b.slice(1)} | ${count} | ${pct}% |\n`;
  }
  report += `\n`;

  // Band power timeline (30s epoch averages)
  if (telemetry.length > 0) {
    report += `## Band Power Timeline\n\n`;
    report += `*Normalized values (0.00–1.00) averaged over 30-second windows*\n\n`;
    report += `| Window | δ | θ | α | β | γ | Dominant |\n`;
    report += `|--------|-----|-----|-----|-----|-----|----------|\n`;

    const epochSize = 30; // seconds per epoch
    const epochs: { start: number; end: number; snapshots: typeof telemetry }[] = [];
    let epochStart = 0;
    while (epochStart < elapsedSeconds) {
      const epochEnd = Math.min(epochStart + epochSize, elapsedSeconds);
      const snapshots = telemetry.filter(t => t.elapsed >= epochStart && t.elapsed < epochEnd);
      if (snapshots.length > 0) {
        epochs.push({ start: epochStart, end: epochEnd, snapshots });
      }
      epochStart += epochSize;
    }

    for (const ep of epochs) {
      const avg: Record<string, number> = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
      for (const s of ep.snapshots) {
        for (const k of bands) avg[k] += s.bands[k as keyof NormalizedBands] / ep.snapshots.length;
      }
      let epDominant = 'alpha';
      let epMax = -1;
      for (const [k, v] of Object.entries(avg)) {
        if (v > epMax) { epMax = v; epDominant = k; }
      }
      const label = `${formatDuration(ep.start)}–${formatDuration(ep.end)}`;
      report += `| ${label} | ${avg.delta.toFixed(2)} | ${avg.theta.toFixed(2)} | ${avg.alpha.toFixed(2)} | ${avg.beta.toFixed(2)} | ${avg.gamma.toFixed(2)} | ${BAND_LABELS[epDominant]} |\n`;
    }
    report += `\n`;
  }

  // Energy / asymmetry profile
  if (telemetry.length > 0) {
    const avgEnergy = telemetry.reduce((s, t) => s + t.energy, 0) / telemetry.length;
    const avgAsym = telemetry.reduce((s, t) => s + t.asymmetry, 0) / telemetry.length;
    const peakEnergy = Math.max(...telemetry.map(t => t.energy));

    report += `## Audio Energy Profile\n\n`;
    report += `| Metric | Value |\n`;
    report += `|--------|-------|\n`;
    report += `| Average Energy | ${(avgEnergy * 100).toFixed(1)}% |\n`;
    report += `| Peak Energy | ${(peakEnergy * 100).toFixed(1)}% |\n`;
    report += `| Average Asymmetry | ${avgAsym > 0 ? '+' : ''}${avgAsym.toFixed(3)} (${avgAsym > 0.05 ? 'right-biased' : avgAsym < -0.05 ? 'left-biased' : 'balanced'}) |\n`;
    report += `\n`;
  }

  // Calibration baseline
  if (calibration && calibration.samples > 0) {
    report += `## Calibration Baseline\n\n`;
    report += `*${calibration.samples} samples collected during 15-second calibration*\n\n`;
    report += `| Band | Mean (µV²) | StdDev |\n`;
    report += `|------|-----------|--------|\n`;
    for (const b of bands) {
      const mean = calibration.mean[b as keyof NormalizedBands];
      const std = calibration.stddev[b as keyof NormalizedBands];
      report += `| ${b} | ${mean.toExponential(3)} | ${std.toExponential(3)} |\n`;
    }
    report += `\n`;
  }

  // Spike event log (full)
  if (spikeLog.length > 0) {
    report += `## Spike Event Log\n\n`;
    report += `| Time | Band | Velocity |\n`;
    report += `|------|------|----------|\n`;
    for (const evt of spikeLog) {
      const time = formatDuration(evt.elapsed);
      const vel = (evt.velocity * 100).toFixed(0);
      report += `| ${time} | ${evt.band} | ${vel}% |\n`;
    }
    report += `\n`;
  }

  report += `---\n\n`;
  report += `*Generated by CORTEX Neurofeedback Engine*  \n`;
  report += `*Share this report with your AI analyst for deeper insights into your brainwave patterns*\n`;

  return report;
}

// ─── Neural Reactor Canvas ───────────────────────────────────────────────────

function drawReactor(
  canvas: HTMLCanvasElement,
  normalized: NormalizedBands,
  dominant: string,
  state: NeuroState,
  calibrationProgress: number,
  sessionElapsed: number,
  sessionDuration: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.max(0, Math.min(cx, cy) - 20);

  ctx.clearRect(0, 0, w, h);

  // Skip drawing if canvas is not visible (zero size)
  if (maxR <= 0) return;

  if (state === 'idle') {
    // Draw idle state — dim concentric rings
    const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma'];
    for (let i = 0; i < bands.length; i++) {
      const r = maxR * (0.3 + i * 0.14);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = BAND_COLORS[bands[i]];
      ctx.globalAlpha = 0.1;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Center text
    ctx.fillStyle = '#555570';
    ctx.font = '12px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AWAITING SIGNAL', cx, cy);
    return;
  }

  if (state === 'calibrating') {
    // Calibration ring
    const r = maxR * 0.6;
    const progress = calibrationProgress / 15;

    // Background ring
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#2a2a3d';
    ctx.lineWidth = 6;
    ctx.stroke();

    // Progress arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.lineCap = 'butt';

    // Glow effect
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 6;
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 15;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Center text
    ctx.fillStyle = '#e0e0f0';
    ctx.font = '500 14px "JetBrains Mono"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CALIBRATING', cx, cy - 14);
    ctx.font = '28px "JetBrains Mono"';
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(`${Math.ceil(15 - calibrationProgress)}`, cx, cy + 16);
    return;
  }

  // Active / Paused state — draw the reactor
  const bands = ['delta', 'theta', 'alpha', 'beta', 'gamma'] as const;
  const time = Date.now() / 1000;

  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const value = state === 'paused' ? 0.3 : normalized[band];
    const baseR = maxR * (0.28 + i * 0.14);
    const color = BAND_COLORS[band];

    // Arc length proportional to normalized value (min 30°, max 340°)
    const arcAngle = (0.15 + value * 0.8) * Math.PI * 2;
    // Slow rotation per ring (each ring rotates at a different speed)
    const rotation = time * (0.15 + i * 0.08) * (i % 2 === 0 ? 1 : -1);
    const startAngle = rotation - arcAngle / 2;
    const endAngle = rotation + arcAngle / 2;

    // Glow intensity based on value
    const glowAlpha = 0.05 + value * 0.2;
    const lineWidth = 3 + value * 5;

    // Background ring (dim)
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.06;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Active arc
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, startAngle, endAngle);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4 + value * 0.6;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Glow
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, startAngle, endAngle);
    ctx.strokeStyle = color;
    ctx.globalAlpha = glowAlpha;
    ctx.lineWidth = lineWidth + 8;
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineCap = 'butt';
  }

  ctx.globalAlpha = 1;

  // Center: dominant state
  const domColor = BAND_COLORS[dominant] || '#e0e0f0';
  const domLabel = BAND_LABELS[dominant] || '';

  // Center glow circle
  ctx.beginPath();
  ctx.arc(cx, cy, maxR * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = domColor;
  ctx.globalAlpha = 0.06;
  ctx.fill();
  ctx.globalAlpha = 1;

  // Center text
  ctx.fillStyle = domColor;
  ctx.font = '500 11px "JetBrains Mono"';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.5;
  ctx.fillText(`${dominant.toUpperCase()}`, cx, cy - 10);
  ctx.globalAlpha = 1;
  ctx.font = '700 16px "Space Grotesk"';
  ctx.fillText(domLabel, cx, cy + 10);

  // ── Session clock (bottom-left) ──
  if (state === 'active' || state === 'paused') {
    const formatTime = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#e0e0f0';
    ctx.font = '500 13px "JetBrains Mono"';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';

    const clockText = sessionDuration > 0
      ? `${formatTime(sessionElapsed)} / ${formatTime(sessionDuration)}`
      : formatTime(sessionElapsed);
    ctx.fillText(clockText, 12, h - 12);

    // Session progress bar (if timed)
    if (sessionDuration > 0) {
      const barW = 80;
      const barH = 3;
      const barX = 12;
      const barY = h - 8;
      const progress = Math.min(1, sessionElapsed / sessionDuration);

      ctx.fillStyle = '#2a2a3d';
      ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(barX, barY, barW * progress, barH);
    }
    ctx.restore();
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Neuro() {
  const [state, setState] = useState<NeuroState>('idle');
  const [calibProgress, setCalibProgress] = useState(0);
  const [mapping, setMapping] = useState<MappingSnapshot | null>(null);
  const [normalized, setNormalized] = useState<NormalizedBands>({
    delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0,
  });
  const [dominant, setDominant] = useState('alpha');
  const [volume, setVolume] = useState(-6);
  const [isStreaming, setIsStreaming] = useState(false);

  // Session state
  const [sessionDuration, setSessionDuration] = useState(0); // 0 = unlimited
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [spikeLog, setSpikeLog] = useState<SpikeEvent[]>([]);
  const [spikeCounts, setSpikeCounts] = useState<Record<string, number>>({
    delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0,
  });

  // Session-complete modal
  const [showModal, setShowModal] = useState(false);
  const [finalStats, setFinalStats] = useState<SessionStats | null>(null);
  const prevStateRef = useRef<NeuroState>('idle');

  const engineRef = useRef<NeuroEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number | null>(null);
  const spikeLogRef = useRef<HTMLDivElement>(null);

  // Initialize engine once
  useEffect(() => {
    const engine = new NeuroEngine();
    engineRef.current = engine;

    engine.setCallbacks({
      onStateChange: (s) => {
        const wasActive = prevStateRef.current === 'active' || prevStateRef.current === 'paused';
        setState(s);
        prevStateRef.current = s;

        if (s === 'idle' && wasActive) {
          // Session ended — freeze final stats and show modal
          const stats = engine.getSessionStats();
          setSpikeCounts({ ...stats.spikeCounts });
          setSpikeLog([...stats.spikeLog]);
          setFinalStats(stats);
          // Delay modal slightly to let audio fade begin
          setTimeout(() => setShowModal(true), 600);
        }
      },
      onCalibrationProgress: (elapsed) => setCalibProgress(elapsed),
      onMappingUpdate: (m, n, d) => {
        setMapping(m);
        setNormalized(n);
        setDominant(d);
      },
      onSpikeEvent: (event) => {
        setSpikeLog(prev => [...prev, event]);
        setSpikeCounts(prev => ({
          ...prev,
          [event.band]: (prev[event.band] || 0) + 1,
        }));
      },
      onSessionTick: (elapsed) => {
        setSessionElapsed(elapsed);
      },
    });

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  // Subscribe to band updates from monitor-engine
  useEffect(() => {
    const unsub = onBandUpdate((bands, perChannel) => {
      engineRef.current?.feedBands(bands, perChannel);
      setIsStreaming(true);
    });

    // Also check streaming status periodically
    const interval = setInterval(() => {
      setIsStreaming(getIsStreaming());
    }, 1000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, []);

  // Canvas animation loop
  useEffect(() => {
    const draw = () => {
      if (canvasRef.current) {
        const engine = engineRef.current;
        drawReactor(
          canvasRef.current,
          engine?.getNormalized() ?? normalized,
          engine?.getDominantBand() ?? dominant,
          state,
          calibProgress,
          engine?.getSessionElapsed() ?? sessionElapsed,
          engine?.getSessionDuration() ?? sessionDuration,
        );
      }
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [state, calibProgress, normalized, dominant, sessionElapsed, sessionDuration]);

  const handleStart = useCallback(async () => {
    if (!isStreaming) return;
    // Reset session state
    setSpikeLog([]);
    setSpikeCounts({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });
    setSessionElapsed(0);
    setShowModal(false);
    setFinalStats(null);

    const engine = engineRef.current;
    if (engine) {
      engine.setSessionDuration(sessionDuration);
      await engine.start();
    }
  }, [isStreaming, sessionDuration]);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
  }, []);

  const handlePauseResume = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.getState() === 'active') engine.pause();
    else if (engine.getState() === 'paused') engine.resume();
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    engineRef.current?.setMasterVolume(val);
  }, []);

  const handleDownloadReport = useCallback(() => {
    if (!finalStats) return;
    const report = generateSessionReport(finalStats);
    const blob = new Blob([report], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toISOString().slice(11, 16).replace(':', '');
    a.href = url;
    a.download = `cortex-session-${dateStr}-${timeStr}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [finalStats]);

  // Auto-scroll spike log
  useEffect(() => {
    if (spikeLogRef.current) {
      spikeLogRef.current.scrollTop = spikeLogRef.current.scrollHeight;
    }
  }, [spikeLog]);

  const calibration = engineRef.current?.getCalibration();

  return (
    <div className="neuro-page">
      {/* Control Bar */}
      <div className="neuro-control-bar">
        <div className="neuro-controls-left">
          {state === 'idle' ? (
            <button
              className="neuro-start-btn"
              onClick={handleStart}
              disabled={!isStreaming}
              title={!isStreaming ? 'Connect headband first (Monitor tab)' : 'Start neurofeedback session'}
            >
              <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              START
            </button>
          ) : (
            <>
              <button className="neuro-stop-btn" onClick={handleStop}>
                <svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" /></svg>
                STOP
              </button>
              {(state === 'active' || state === 'paused') && (
                <button className="neuro-pause-btn" onClick={handlePauseResume}>
                  {state === 'paused' ? (
                    <><svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>RESUME</>
                  ) : (
                    <><svg viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>PAUSE</>
                  )}
                </button>
              )}
            </>
          )}
        </div>

        <div className="neuro-status">
          {state === 'idle' && !isStreaming && (
            <span className="neuro-status-text warn">Connect headband first</span>
          )}
          {state === 'idle' && isStreaming && (
            <span className="neuro-status-text ready">Ready — press START</span>
          )}
          {state === 'calibrating' && (
            <span className="neuro-status-text calibrating">
              Calibrating... {Math.ceil(15 - calibProgress)}s
            </span>
          )}
          {state === 'active' && (
            <span className="neuro-status-text active">● LIVE</span>
          )}
          {state === 'paused' && (
            <span className="neuro-status-text paused">PAUSED</span>
          )}
        </div>

        {/* Session timer config */}
        <div className="neuro-session-timer">
          <span className="neuro-session-label">SESSION</span>
          <select
            className="neuro-session-select"
            value={sessionDuration}
            onChange={(e) => setSessionDuration(parseInt(e.target.value))}
            disabled={state !== 'idle'}
          >
            <option value={0}>∞ Open</option>
            <option value={60}>1 min</option>
            <option value={120}>2 min</option>
            <option value={300}>5 min</option>
            <option value={600}>10 min</option>
            <option value={900}>15 min</option>
            <option value={1200}>20 min</option>
            <option value={1800}>30 min</option>
          </select>
        </div>

        <div className="neuro-volume">
          <span className="neuro-volume-label">VOL</span>
          <input
            type="range"
            min="-40"
            max="0"
            step="1"
            value={volume}
            onChange={handleVolumeChange}
            className="neuro-volume-slider"
          />
          <span className="neuro-volume-value">{volume} dB</span>
        </div>
      </div>

      {/* Reactor + Spike Log Row */}
      <div className="neuro-reactor-row">
        {/* Neural Reactor */}
        <div className="panel neuro-reactor-panel">
          <canvas ref={canvasRef} className="neuro-reactor-canvas" />
        </div>

        {/* Spike Log */}
        <div className="panel neuro-spike-panel">
          <div className="neuro-spike-header">
            <span className="panel-title">SPIKE LOG</span>
            <span className="neuro-spike-total">{spikeLog.length} total</span>
          </div>

          {/* Per-band spike counters */}
          <div className="neuro-spike-counts">
            {(['delta', 'theta', 'alpha', 'beta', 'gamma'] as const).map((band) => (
              <div className="neuro-spike-count-row" key={band}>
                <span className="neuro-spike-band" style={{ color: BAND_COLORS[band] }}>
                  {band[0].toUpperCase()}
                </span>
                <div className="neuro-spike-count-bar">
                  <div
                    className="neuro-spike-count-fill"
                    style={{
                      width: spikeLog.length > 0
                        ? `${Math.min(100, ((spikeCounts[band] || 0) / Math.max(1, spikeLog.length)) * 100)}%`
                        : '0%',
                      backgroundColor: BAND_COLORS[band],
                    }}
                  />
                </div>
                <span className="neuro-spike-count-val">{spikeCounts[band] || 0}</span>
              </div>
            ))}
          </div>

          {/* Scrollable event list */}
          <div className="neuro-spike-log" ref={spikeLogRef}>
            {spikeLog.length === 0 ? (
              <div className="neuro-spike-empty">
                {state === 'active' ? 'Listening for spikes…' : 'No events yet'}
              </div>
            ) : (
              spikeLog.slice(-100).map((evt, i) => (
                <div className="neuro-spike-event" key={i}>
                  <span className="neuro-spike-time">
                    {Math.floor(evt.elapsed / 60)}:{Math.floor(evt.elapsed % 60).toString().padStart(2, '0')}
                  </span>
                  <span
                    className="neuro-spike-dot"
                    style={{ backgroundColor: BAND_COLORS[evt.band] }}
                  />
                  <span className="neuro-spike-band-label" style={{ color: BAND_COLORS[evt.band] }}>
                    {evt.band}
                  </span>
                  <span className="neuro-spike-vel">
                    {(evt.velocity * 100).toFixed(0)}%
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Mapping Matrix */}
      <div className="neuro-mapping-grid">
        <MappingCard
          band="alpha"
          symbol="α"
          target="Filter / Gain"
          normalized={normalized.alpha}
          detail={mapping ? `ƒ = ${Math.round(mapping.alpha.filterFreq)} Hz` : '—'}
          color={BAND_COLORS.alpha}
          active={state === 'active'}
        />
        <MappingCard
          band="theta"
          symbol="θ"
          target="Reverb Depth"
          normalized={normalized.theta}
          detail={mapping ? `wet = ${mapping.theta.reverbWet.toFixed(2)}` : '—'}
          color={BAND_COLORS.theta}
          active={state === 'active'}
        />
        <MappingCard
          band="beta"
          symbol="β"
          target="Texture"
          normalized={normalized.beta}
          detail={mapping ? `ƒ = ${Math.round(mapping.beta.noiseFreq)} Hz` : '—'}
          color={BAND_COLORS.beta}
          active={state === 'active'}
        />
        <MappingCard
          band="delta"
          symbol="δ"
          target="Sub Bass + Pitch"
          normalized={normalized.delta}
          detail={mapping ? `gain = ${mapping.delta.subGain.toFixed(2)}  ƒ = ${Math.round(mapping.delta.droneFreq)} Hz` : '—'}
          color={BAND_COLORS.delta}
          active={state === 'active'}
        />
        <MappingCard
          band="gamma"
          symbol="γ"
          target="Shimmer"
          normalized={normalized.gamma}
          detail={mapping ? (mapping.gamma.shimmerRate > 0 ? `${mapping.gamma.shimmerRate} notes/s` : 'quiet') : '—'}
          color={BAND_COLORS.gamma}
          active={state === 'active'}
        />
        <div className="neuro-mapping-card">
          <div className="mapping-header">
            <span className="mapping-symbol" style={{ color: '#818cf8' }}>⚡</span>
            <span className="mapping-band">SPIKES</span>
          </div>
          <div className="mapping-target">→ Melodic Pluck</div>
          <div className="mapping-bar-container">
            <div
              className="mapping-bar spike-bar"
              style={{
                width: state === 'active' && mapping ? `${Math.min(100, (mapping.spikesThisCycle / 3) * 100)}%` : '0%',
                backgroundColor: '#f472b6',
                boxShadow: mapping && mapping.spikesThisCycle > 0 ? '0 0 12px #f472b680' : 'none',
              }}
            />
          </div>
          <div className="mapping-detail" style={{ color: '#f472b6' }}>
            {state === 'active' && mapping ? (mapping.spikesThisCycle > 0 ? `${mapping.spikesThisCycle} pluck${mapping.spikesThisCycle > 1 ? 's' : ''}` : 'listening…') : '—'}
          </div>
        </div>
        <div className="neuro-mapping-card">
          <div className="mapping-header">
            <span className="mapping-symbol" style={{ color: '#818cf8' }}>↔</span>
            <span className="mapping-band">ASYMMETRY</span>
          </div>
          <div className="mapping-target">→ Stereo Pan</div>
          <div className="mapping-pan-bar">
            <div className="mapping-pan-label">L</div>
            <div className="mapping-pan-track">
              <div
                className="mapping-pan-thumb"
                style={{
                  left: `${50 + (mapping?.asymmetry.pan ?? 0) * 50}%`,
                  backgroundColor: '#818cf8',
                }}
              />
            </div>
            <div className="mapping-pan-label">R</div>
          </div>
          <div className="mapping-detail" style={{ color: '#818cf8' }}>
            {mapping ? `pan = ${mapping.asymmetry.pan > 0 ? '+' : ''}${mapping.asymmetry.pan.toFixed(2)}` : '—'}
          </div>
        </div>
      </div>

      {/* Baseline / Calibration Stats */}
      {calibration && calibration.samples > 0 && (
        <div className="neuro-baseline">
          <div className="neuro-baseline-header">
            <span className="panel-title">BASELINE ({calibration.samples} samples)</span>
          </div>
          <div className="neuro-baseline-grid">
            {(['delta', 'theta', 'alpha', 'beta', 'gamma'] as const).map((band) => {
              const mean = calibration.mean[band];
              const db = mean > 0 ? (10 * Math.log10(mean * 1e6)).toFixed(1) : '0';
              return (
                <div className="neuro-baseline-item" key={band}>
                  <span className="neuro-baseline-band" style={{ color: BAND_COLORS[band] }}>
                    {band}
                  </span>
                  <span className="neuro-baseline-value">{db} dB</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Session Complete Modal */}
      {showModal && finalStats && (
        <div className="neuro-modal-overlay" onClick={() => setShowModal(false)}>
          <div className="neuro-modal" onClick={(e) => e.stopPropagation()}>
            <div className="neuro-modal-glow" />
            <div className="neuro-modal-content">
              <div className="neuro-modal-icon">✧</div>
              <h2 className="neuro-modal-title">Session Complete</h2>
              <p className="neuro-modal-subtitle">
                Incredible work. {formatDuration(finalStats.elapsedSeconds)} of pure neural exploration — your brain just composed something beautiful.
              </p>

              <div className="neuro-modal-stats">
                <div className="neuro-modal-stat">
                  <span className="neuro-modal-stat-value">{formatDuration(finalStats.elapsedSeconds)}</span>
                  <span className="neuro-modal-stat-label">duration</span>
                </div>
                <div className="neuro-modal-stat">
                  <span className="neuro-modal-stat-value">{finalStats.totalSpikes}</span>
                  <span className="neuro-modal-stat-label">spikes</span>
                </div>
                <div className="neuro-modal-stat">
                  <span className="neuro-modal-stat-value">
                    {finalStats.elapsedSeconds > 0
                      ? (finalStats.totalSpikes / (finalStats.elapsedSeconds / 60)).toFixed(1)
                      : '0'}
                  </span>
                  <span className="neuro-modal-stat-label">spikes/min</span>
                </div>
                <div className="neuro-modal-stat">
                  <span className="neuro-modal-stat-value" style={{ color: BAND_COLORS[(() => {
                    let best = 'alpha'; let max = -1;
                    for (const [k, v] of Object.entries(finalStats.spikeCounts)) {
                      const avg = finalStats.telemetry.reduce((s, t) => s + t.bands[k as keyof NormalizedBands], 0);
                      if (avg > max) { max = avg; best = k; }
                    }
                    return best;
                  })()] || '#e0e0f0' }}>
                    {(() => {
                      let best = 'alpha'; let max = -1;
                      for (const k of Object.keys(finalStats.spikeCounts)) {
                        const avg = finalStats.telemetry.reduce((s, t) => s + t.bands[k as keyof NormalizedBands], 0);
                        if (avg > max) { max = avg; best = k; }
                      }
                      return BAND_LABELS[best] || best;
                    })()}
                  </span>
                  <span className="neuro-modal-stat-label">dominant</span>
                </div>
              </div>

              {/* Spike distribution mini-bars */}
              <div className="neuro-modal-bands">
                {(['delta', 'theta', 'alpha', 'beta', 'gamma'] as const).map((band) => {
                  const count = finalStats.spikeCounts[band] || 0;
                  const pct = finalStats.totalSpikes > 0
                    ? Math.round((count / finalStats.totalSpikes) * 100)
                    : 0;
                  return (
                    <div className="neuro-modal-band-row" key={band}>
                      <span className="neuro-modal-band-name" style={{ color: BAND_COLORS[band] }}>
                        {band[0].toUpperCase()}
                      </span>
                      <div className="neuro-modal-band-track">
                        <div
                          className="neuro-modal-band-fill"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: BAND_COLORS[band],
                          }}
                        />
                      </div>
                      <span className="neuro-modal-band-pct">{pct}%</span>
                    </div>
                  );
                })}
              </div>

              <p className="neuro-modal-cta">
                Your session report is ready — share it with your AI analyst for deeper insights!
              </p>

              <div className="neuro-modal-actions">
                <button className="neuro-modal-download" onClick={handleDownloadReport}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  Download Report
                </button>
                <button className="neuro-modal-dismiss" onClick={() => setShowModal(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Mapping Card ────────────────────────────────────────────────────────────

function MappingCard({
  band,
  symbol,
  target,
  normalized,
  detail,
  color,
  active,
}: {
  band: string;
  symbol: string;
  target: string;
  normalized: number;
  detail: string;
  color: string;
  active: boolean;
}) {
  const pct = Math.round(normalized * 100);
  return (
    <div className="neuro-mapping-card">
      <div className="mapping-header">
        <span className="mapping-symbol" style={{ color }}>{symbol}</span>
        <span className="mapping-band">{band.toUpperCase()}</span>
      </div>
      <div className="mapping-target">→ {target}</div>
      <div className="mapping-bar-container">
        <div
          className="mapping-bar"
          style={{
            width: active ? `${pct}%` : '0%',
            backgroundColor: color,
            boxShadow: active ? `0 0 8px ${color}40` : 'none',
          }}
        />
      </div>
      <div className="mapping-detail" style={{ color }}>
        {active ? detail : '—'}
      </div>
    </div>
  );
}
