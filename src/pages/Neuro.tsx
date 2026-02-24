import { useState, useEffect, useRef, useCallback } from 'react';
import NeuroEngine, {
  type NeuroState,
  type MappingSnapshot,
  type NormalizedBands,
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

// ─── Neural Reactor Canvas ───────────────────────────────────────────────────

function drawReactor(
  canvas: HTMLCanvasElement,
  normalized: NormalizedBands,
  dominant: string,
  state: NeuroState,
  calibrationProgress: number,
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
  const maxR = Math.min(cx, cy) - 20;

  ctx.clearRect(0, 0, w, h);

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

  const engineRef = useRef<NeuroEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number | null>(null);

  // Initialize engine once
  useEffect(() => {
    const engine = new NeuroEngine();
    engineRef.current = engine;

    engine.setCallbacks({
      onStateChange: (s) => setState(s),
      onCalibrationProgress: (elapsed) => setCalibProgress(elapsed),
      onMappingUpdate: (m, n, d) => {
        setMapping(m);
        setNormalized(n);
        setDominant(d);
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
        );
      }
      animRef.current = requestAnimationFrame(draw);
    };
    animRef.current = requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [state, calibProgress, normalized, dominant]);

  const handleStart = useCallback(async () => {
    if (!isStreaming) return;
    await engineRef.current?.start();
  }, [isStreaming]);

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

      {/* Neural Reactor */}
      <div className="panel neuro-reactor-panel">
        <canvas ref={canvasRef} className="neuro-reactor-canvas" />
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
          target="Sub Bass"
          normalized={normalized.delta}
          detail={mapping ? `gain = ${mapping.delta.subGain.toFixed(2)}` : '—'}
          color={BAND_COLORS.delta}
          active={state === 'active'}
        />
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
