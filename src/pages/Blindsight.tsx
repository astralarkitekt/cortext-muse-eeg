import { useState, useEffect, useRef, useCallback } from 'react';
import { BlindsightEngine } from '../lib/blindsight/engine';
import { getIsStreaming } from '../monitor-engine';
import { loadGallery, saveToGallery, deleteFromGallery } from '../lib/blindsight/gallery';
import { exportGif, downloadBlob, type GifExportProgress } from '../lib/blindsight/gif-export';
import type {
  BlindState,
  EyeState,
  BrushState,
  GestureRecord,
  SessionSummary,
  RevealMode,
  MappingMode,
  SymmetryMode,
  GalleryEntry,
} from '../lib/blindsight/types';

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function Blindsight() {
  // Core state
  const [state, setState] = useState<BlindState>('idle');
  const [isStreaming, setIsStreaming] = useState(false);
  const [calibProgress, setCalibProgress] = useState(0);

  // Eye & brush
  const [eyeState, setEyeState] = useState<EyeState>({
    closed: false, closedAt: null, openedAt: null, duration: 0, confidence: 0,
  });
  const [brush, setBrush] = useState<BrushState | null>(null);

  // Session tracking
  const [gestureCount, setGestureCount] = useState(0);
  const [paintTime, setPaintTime] = useState(0);
  const [gestures, setGestures] = useState<GestureRecord[]>([]);
  const [revealProgress, setRevealProgress] = useState(0);
  const [jawClenches, setJawClenches] = useState(0);

  // Config
  const [revealMode, setRevealMode] = useState<RevealMode>('fade');
  const [mappingMode, setMappingMode] = useState<MappingMode>('fixed');
  const [symmetryMode, setSymmetryMode] = useState<SymmetryMode>('none');
  const [soundEnabled, setSoundEnabled] = useState(false);

  // Completion
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [showComplete, setShowComplete] = useState(false);

  // Replay
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayProgress, setReplayProgress] = useState(0);

  // GIF export
  const [isExportingGif, setIsExportingGif] = useState(false);
  const [gifProgress, setGifProgress] = useState(0);

  // Gallery
  const [gallery, setGallery] = useState<GalleryEntry[]>([]);
  const [showGallery, setShowGallery] = useState(false);
  const [viewingEntry, setViewingEntry] = useState<GalleryEntry | null>(null);

  const engineRef = useRef<BlindsightEngine | null>(null);
  const paintCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const gestureLogRef = useRef<HTMLDivElement>(null);
  const paintTimeTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Engine lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    const engine = new BlindsightEngine({ revealMode, mappingMode });
    engineRef.current = engine;

    engine.setCallbacks({
      onStateChange: (s) => {
        setState(s);
        if (s === 'complete') {
          const sum = engine.getSessionSummary();
          setSummary(sum);
          setShowComplete(true);
        }
      },
      onCalibrationProgress: (elapsed) => setCalibProgress(elapsed),
      onEyeStateChange: (eye) => setEyeState(eye),
      onBrushUpdate: (b) => setBrush(b),
      onGestureStart: (idx) => {
        setGestureCount(idx);
      },
      onGestureEnd: (gesture) => {
        setGestures(prev => [...prev, gesture]);
      },
      onRevealProgress: (p) => setRevealProgress(p),
      onJawClench: () => setJawClenches(prev => prev + 1),
      onReplayProgress: (p) => setReplayProgress(p),
      onReplayComplete: () => { setIsReplaying(false); setReplayProgress(0); },
    });

    // Load gallery on mount
    setGallery(loadGallery());

    return () => {
      engine.reset();
      engineRef.current = null;
    };
  }, []); // Engine is created once; config changes are handled separately

  // Attach canvases when available
  useEffect(() => {
    const engine = engineRef.current;
    if (engine && paintCanvasRef.current && overlayCanvasRef.current) {
      engine.attachCanvas(paintCanvasRef.current, overlayCanvasRef.current);
    }
  }, []);

  // Handle resize
  useEffect(() => {
    const handleResize = () => engineRef.current?.resizeCanvas();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Check streaming
  useEffect(() => {
    const interval = setInterval(() => setIsStreaming(getIsStreaming()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Update paint time while painting
  useEffect(() => {
    if (state === 'painting') {
      paintTimeTimer.current = setInterval(() => {
        setPaintTime(engineRef.current?.getTotalPaintTime() ?? 0);
      }, 500);
    } else {
      if (paintTimeTimer.current) {
        clearInterval(paintTimeTimer.current);
        paintTimeTimer.current = null;
      }
      setPaintTime(engineRef.current?.getTotalPaintTime() ?? 0);
    }
    return () => {
      if (paintTimeTimer.current) clearInterval(paintTimeTimer.current);
    };
  }, [state]);

  // Auto-scroll gesture log
  useEffect(() => {
    if (gestureLogRef.current) {
      gestureLogRef.current.scrollTop = gestureLogRef.current.scrollHeight;
    }
  }, [gestures]);

  // ─── Handlers ──────────────────────────────────────────────────────────

  const handleCalibrate = useCallback(() => {
    if (!isStreaming) return;
    setGestures([]);
    setGestureCount(0);
    setPaintTime(0);
    setJawClenches(0);
    setSummary(null);
    setShowComplete(false);
    setRevealProgress(0);
    engineRef.current?.reset();

    // Brief delay for canvas attach
    setTimeout(() => {
      if (paintCanvasRef.current && overlayCanvasRef.current) {
        engineRef.current?.attachCanvas(paintCanvasRef.current, overlayCanvasRef.current);
      }
      engineRef.current?.startCalibration();
    }, 50);
  }, [isStreaming]);

  const handleFinish = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const sum = engine.finish();
    setSummary(sum);
    setShowComplete(true);
  }, []);

  const handleReset = useCallback(() => {
    engineRef.current?.reset();
    setGestures([]);
    setGestureCount(0);
    setPaintTime(0);
    setJawClenches(0);
    setSummary(null);
    setShowComplete(false);
    setRevealProgress(0);
    setCalibProgress(0);
  }, []);

  const handleSavePNG = useCallback(() => {
    const dataUrl = engineRef.current?.exportPNG();
    if (!dataUrl) return;
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = dataUrl;
    a.download = `blindsight-${dateStr}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  const handleSaveToGallery = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const canvas = engine.getPaintCanvas();
    const sum = engine.getSessionSummary();
    if (!canvas) return;
    saveToGallery(canvas, sum);
    setGallery(loadGallery());
  }, []);

  const handleReplay = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setIsReplaying(true);
    setReplayProgress(0);
    setShowComplete(false);
    engine.startReplay(8);
  }, []);

  const handleStopReplay = useCallback(() => {
    engineRef.current?.stopReplay();
    setIsReplaying(false);
    setReplayProgress(0);
  }, []);

  const handleDeleteGalleryEntry = useCallback((id: string) => {
    deleteFromGallery(id);
    setGallery(loadGallery());
    if (viewingEntry?.id === id) setViewingEntry(null);
  }, [viewingEntry]);

  const handleToggleSound = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const next = !soundEnabled;
    setSoundEnabled(next);
    await engine.setSoundEnabled(next);
  }, [soundEnabled]);

  const handleSymmetryChange = useCallback((mode: SymmetryMode) => {
    setSymmetryMode(mode);
    engineRef.current?.setSymmetryMode(mode);
  }, []);

  const handleExportGif = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const frames = engine.getStrokeFrames();
    if (frames.length === 0) return;

    const canvas = engine.getPaintCanvas();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    setIsExportingGif(true);
    setGifProgress(0);
    setShowComplete(false);

    try {
      const blob = await exportGif(
        frames,
        rect.width,
        rect.height,
        symmetryMode,
        (p: GifExportProgress) => setGifProgress(p.progress),
      );
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `blindsight-${dateStr}.gif`);
    } catch (err) {
      console.error('GIF export failed:', err);
    } finally {
      setIsExportingGif(false);
      setGifProgress(0);
    }
  }, [symmetryMode]);

  // ─── State label ───────────────────────────────────────────────────────

  const stateLabel = (() => {
    switch (state) {
      case 'idle': return isStreaming ? 'Ready' : 'Connect headband';
      case 'calibrating': return `Calibrating… ${Math.ceil(15 - calibProgress)}s`;
      case 'waiting': return 'EYES OPEN — close eyes to paint';
      case 'painting': return `PAINTING — gesture #${gestureCount}`;
      case 'revealing': return 'REVEALING…';
      case 'complete': return 'Session complete';
    }
  })();

  const stateClass = (() => {
    switch (state) {
      case 'idle': return isStreaming ? 'ready' : 'warn';
      case 'calibrating': return 'calibrating';
      case 'waiting': return 'active';
      case 'painting': return 'painting';
      case 'revealing': return 'revealing';
      case 'complete': return 'complete';
    }
  })();

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="blind-page">
      {/* Control Bar */}
      <div className="blind-control-bar">
        <div className="blind-controls-left">
          {(state === 'idle' || state === 'complete') ? (
            <button
              className="blind-start-btn"
              onClick={handleCalibrate}
              disabled={!isStreaming}
              title={!isStreaming ? 'Connect headband first (Monitor tab)' : 'Start calibration'}
            >
              <svg viewBox="0 0 24 24" width="14" height="14">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
              {state === 'complete' ? 'NEW SESSION' : 'CALIBRATE'}
            </button>
          ) : state !== 'calibrating' ? (
            <button className="blind-finish-btn" onClick={handleFinish}>
              <svg viewBox="0 0 24 24" width="14" height="14">
                <rect x="6" y="6" width="12" height="12" fill="currentColor" rx="2" />
              </svg>
              FINISH
            </button>
          ) : null}
        </div>

        <div className="blind-status">
          <span className={`blind-status-text ${stateClass}`}>{stateLabel}</span>
        </div>

        <div className="blind-metrics">
          <span className="blind-metric">
            <span className="blind-metric-label">GESTURES</span>
            <span className="blind-metric-value">{gestureCount}</span>
          </span>
          <span className="blind-metric">
            <span className="blind-metric-label">PAINT</span>
            <span className="blind-metric-value">{formatMs(paintTime)}</span>
          </span>
          {eyeState.closed && (
            <span className="blind-metric eye-closed">
              <span className="blind-metric-label">EYES</span>
              <span className="blind-metric-value">CLOSED</span>
            </span>
          )}
          {!eyeState.closed && state !== 'idle' && state !== 'calibrating' && (
            <span className="blind-metric eye-open">
              <span className="blind-metric-label">EYES</span>
              <span className="blind-metric-value">OPEN</span>
            </span>
          )}
          {jawClenches > 0 && (
            <span className="blind-metric">
              <span className="blind-metric-label">STAMPS</span>
              <span className="blind-metric-value">{jawClenches}</span>
            </span>
          )}
        </div>
      </div>

      {/* Session Actions Bar — persistent when session is complete */}
      {state === 'complete' && !isExportingGif && (
        <div className="blind-actions-bar">
          <button className="blind-action-btn blind-action-replay" onClick={handleReplay} disabled={isReplaying}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
            {isReplaying ? 'Playing…' : 'Replay'}
          </button>
          <button className="blind-action-btn blind-action-gif" onClick={handleExportGif} disabled={isReplaying}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="3" y="3" width="18" height="18" rx="4" />
            </svg>
            GIF
          </button>
          <button className="blind-action-btn blind-action-gallery" onClick={handleSaveToGallery}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M8.5 3v4h7v-4M6 14h12M6 18h8" />
            </svg>
            Gallery
          </button>
          <button className="blind-action-btn blind-action-png" onClick={handleSavePNG}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            PNG
          </button>
          {isReplaying && (
            <button className="blind-action-btn blind-action-stop" onClick={handleStopReplay}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </button>
          )}
        </div>
      )}

      {/* Canvas Area */}
      <div className="blind-canvas-container panel">
        <canvas ref={paintCanvasRef} className="blind-paint-canvas" />
        <canvas ref={overlayCanvasRef} className="blind-overlay-canvas" />

        {/* Idle state overlay */}
        {state === 'idle' && (
          <div className="blind-idle-overlay">
            <div className="blind-idle-icon">◎</div>
            <div className="blind-idle-title">BLINDSIGHT</div>
            <div className="blind-idle-subtitle">
              Brain-driven generative painting
            </div>
            <div className="blind-idle-hint">
              {isStreaming
                ? 'Press CALIBRATE to begin. Keep your eyes open during calibration.'
                : 'Connect your Muse headband on the Monitor tab to begin.'}
            </div>
          </div>
        )}

        {/* Calibration overlay */}
        {state === 'calibrating' && (
          <div className="blind-calibration-overlay">
            <div className="blind-calib-ring">
              <svg viewBox="0 0 120 120" width="120" height="120">
                <circle cx="60" cy="60" r="54" fill="none" stroke="#2a2a3d" strokeWidth="4" />
                <circle
                  cx="60" cy="60" r="54"
                  fill="none" stroke="#22d3ee" strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray={`${Math.PI * 108}`}
                  strokeDashoffset={`${Math.PI * 108 * (1 - calibProgress / 15)}`}
                  transform="rotate(-90 60 60)"
                  style={{ transition: 'stroke-dashoffset 0.1s linear' }}
                />
              </svg>
              <div className="blind-calib-center">
                <div className="blind-calib-dot" />
              </div>
            </div>
            <div className="blind-calib-text">
              Keep your eyes open and stare at the dot
            </div>
            <div className="blind-calib-timer">{Math.ceil(15 - calibProgress)}s</div>
          </div>
        )}

        {/* Reveal progress bar */}
        {state === 'revealing' && (
          <div className="blind-reveal-bar">
            <div
              className="blind-reveal-fill"
              style={{ width: `${revealProgress * 100}%` }}
            />
          </div>
        )}
      </div>

      {/* Bottom Panel: Gesture Log + Brush Info */}
      <div className="blind-bottom-row">
        {/* Config panel (only when idle) */}
        {(state === 'idle' || state === 'complete') && (
          <div className="panel blind-config-panel">
            <span className="panel-title">SETTINGS</span>
            <div className="blind-config-grid">
              <label className="blind-config-item">
                <span className="blind-config-label">Reveal</span>
                <select
                  className="blind-config-select"
                  value={revealMode}
                  onChange={(e) => setRevealMode(e.target.value as RevealMode)}
                >
                  <option value="fade">Slow Fade</option>
                  <option value="hard">Hard Cut</option>
                </select>
              </label>
              <label className="blind-config-item">
                <span className="blind-config-label">Mapping</span>
                <select
                  className="blind-config-select"
                  value={mappingMode}
                  onChange={(e) => setMappingMode(e.target.value as MappingMode)}
                >
                  <option value="fixed">Fixed</option>
                  <option value="roundRobin">Round Robin</option>
                </select>
              </label>
              <label className="blind-config-item">
                <span className="blind-config-label">Symmetry</span>
                <select
                  className="blind-config-select"
                  value={symmetryMode}
                  onChange={(e) => handleSymmetryChange(e.target.value as SymmetryMode)}
                >
                  <option value="none">None</option>
                  <option value="bilateral">Bilateral</option>
                  <option value="quad">Quad</option>
                </select>
              </label>
              <label className="blind-config-item">
                <span className="blind-config-label">Sound</span>
                <button
                  className={`blind-sound-toggle ${soundEnabled ? 'active' : ''}`}
                  onClick={handleToggleSound}
                >
                  {soundEnabled ? '♪ ON' : '♪ OFF'}
                </button>
              </label>
            </div>
          </div>
        )}

        {/* Gesture log */}
        <div className="panel blind-gesture-panel">
          <div className="blind-gesture-header">
            <span className="panel-title">GESTURE LOG</span>
            <span className="blind-gesture-total">{gestures.length} gestures</span>
          </div>
          <div className="blind-gesture-log" ref={gestureLogRef}>
            {gestures.length === 0 ? (
              <div className="blind-gesture-empty">
                {state === 'waiting' || state === 'painting'
                  ? 'Close your eyes to create your first gesture…'
                  : 'No gestures yet'}
              </div>
            ) : (
              gestures.map((g) => (
                <div className="blind-gesture-item" key={g.index}>
                  <span className="blind-gesture-idx">#{g.index}</span>
                  <span className="blind-gesture-dur">{(g.duration / 1000).toFixed(1)}s</span>
                  <span className="blind-gesture-pts">{g.strokePoints} pts</span>
                  <span
                    className="blind-gesture-band"
                    style={{ color: BAND_COLORS[g.dominantBand] }}
                  >
                    {BAND_LABELS[g.dominantBand]}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Brush state (live) */}
        {(state === 'painting' || state === 'revealing' || state === 'waiting') && brush && (
          <div className="panel blind-brush-panel">
            <span className="panel-title">BRUSH</span>
            <div className="blind-brush-grid">
              <div className="blind-brush-item">
                <span className="blind-brush-label">position</span>
                <span className="blind-brush-value">
                  {Math.round(brush.x)}, {Math.round(brush.y)}
                </span>
              </div>
              <div className="blind-brush-item">
                <span className="blind-brush-label">hue</span>
                <span className="blind-brush-value">
                  <span
                    className="blind-brush-swatch"
                    style={{ backgroundColor: `hsl(${brush.hue}, 70%, 60%)` }}
                  />
                  {Math.round(brush.hue)}°
                </span>
              </div>
              <div className="blind-brush-item">
                <span className="blind-brush-label">width</span>
                <span className="blind-brush-value">{brush.width.toFixed(1)}px</span>
              </div>
              <div className="blind-brush-item">
                <span className="blind-brush-label">opacity</span>
                <span className="blind-brush-value">{(brush.opacity * 100).toFixed(0)}%</span>
              </div>
              <div className="blind-brush-item">
                <span className="blind-brush-label">curvature</span>
                <span className="blind-brush-value">{(brush.curvature * 100).toFixed(0)}%</span>
              </div>
              <div className="blind-brush-item">
                <span className="blind-brush-label">texture</span>
                <span className="blind-brush-value">{(brush.texture * 100).toFixed(0)}%</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Channel mapping reference */}
      {(state === 'waiting' || state === 'painting' || state === 'revealing') && (
        <div className="blind-mapping-ref">
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: '#22d3ee' }}>◁ ▷</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Look L/R steers X</span>
          </div>
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: '#34d399' }}>△ ▽</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Look U/D steers Y</span>
          </div>
          <div className="blind-mapping-sep" />
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: '#818cf8' }}>TP9</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Color</span>
          </div>
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: '#fbbf24' }}>TP10</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Width</span>
          </div>
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: '#f472b6' }}>JAW</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Stamp</span>
          </div>
          <div className="blind-mapping-sep" />
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: BAND_COLORS.alpha }}>α</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Opacity</span>
          </div>
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: BAND_COLORS.theta }}>θ</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Curvature</span>
          </div>
          <div className="blind-mapping-item">
            <span className="blind-mapping-ch" style={{ color: BAND_COLORS.beta }}>β</span>
            <span className="blind-mapping-arrow">→</span>
            <span className="blind-mapping-param">Texture</span>
          </div>
        </div>
      )}

      {/* Session Complete Modal */}
      {showComplete && summary && (
        <div className="blind-modal-overlay" onClick={() => setShowComplete(false)}>
          <div className="blind-modal" onClick={(e) => e.stopPropagation()}>
            <div className="blind-modal-content">
              <div className="blind-modal-icon">◎</div>
              <h2 className="blind-modal-title">Painting Complete</h2>
              <p className="blind-modal-subtitle">
                {summary.totalGestures} gesture{summary.totalGestures !== 1 ? 's' : ''} over {formatMs(summary.durationMs)} — each one a meditative brushstroke you never saw being created.
              </p>

              <div className="blind-modal-stats">
                <div className="blind-modal-stat">
                  <span className="blind-modal-stat-value">{summary.totalGestures}</span>
                  <span className="blind-modal-stat-label">gestures</span>
                </div>
                <div className="blind-modal-stat">
                  <span className="blind-modal-stat-value">{formatMs(summary.totalPaintTime)}</span>
                  <span className="blind-modal-stat-label">paint time</span>
                </div>
                <div className="blind-modal-stat">
                  <span className="blind-modal-stat-value"
                    style={{ color: BAND_COLORS[summary.dominantBand] }}
                  >
                    {BAND_LABELS[summary.dominantBand]}
                  </span>
                  <span className="blind-modal-stat-label">dominant</span>
                </div>
                {summary.jawClenches > 0 && (
                  <div className="blind-modal-stat">
                    <span className="blind-modal-stat-value" style={{ color: '#f472b6' }}>{summary.jawClenches}</span>
                    <span className="blind-modal-stat-label">stamps</span>
                  </div>
                )}
              </div>

              {/* Gesture summary bars */}
              {summary.gestures.length > 0 && (
                <div className="blind-modal-gestures">
                  {summary.gestures.map((g) => (
                    <div className="blind-modal-gesture-bar" key={g.index} title={`Gesture #${g.index}: ${(g.duration / 1000).toFixed(1)}s — ${BAND_LABELS[g.dominantBand]}`}>
                      <div
                        className="blind-modal-gesture-fill"
                        style={{
                          height: `${Math.min(100, (g.duration / Math.max(1, ...summary.gestures.map(x => x.duration))) * 100)}%`,
                          backgroundColor: BAND_COLORS[g.dominantBand],
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="blind-modal-actions">
                <button className="blind-modal-replay" onClick={handleReplay} title="Watch your painting being created in fast-forward">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                  Replay
                </button>
                <button className="blind-modal-gif" onClick={handleExportGif} title="Export timelapse as animated GIF">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="2" y="2" width="20" height="20" rx="4" />
                    <path d="M8 12h3v4H8zM14 8h3v8h-3" />
                  </svg>
                  Download GIF
                </button>
                <button className="blind-modal-save" onClick={handleSaveToGallery}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M8.5 3v4h7v-4M6 14h12M6 18h8" />
                  </svg>
                  Save to Gallery
                </button>
                <button className="blind-modal-save" onClick={handleSavePNG}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  Download PNG
                </button>
                <button className="blind-modal-dismiss" onClick={() => setShowComplete(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Replay Overlay */}
      {isReplaying && (
        <div className="blind-replay-overlay">
          <div className="blind-replay-label">REPLAYING…</div>
          <div className="blind-replay-bar">
            <div className="blind-replay-fill" style={{ width: `${replayProgress * 100}%` }} />
          </div>
          <button className="blind-replay-skip" onClick={handleStopReplay}>Skip</button>
        </div>
      )}

      {/* GIF Export Progress Overlay */}
      {isExportingGif && (
        <div className="blind-replay-overlay blind-gif-overlay">
          <div className="blind-replay-label">
            <span className="blind-gif-spinner" />
            ENCODING GIF… {Math.round(gifProgress * 100)}%
          </div>
          <div className="blind-replay-bar">
            <div className="blind-replay-fill blind-gif-fill" style={{ width: `${gifProgress * 100}%` }} />
          </div>
        </div>
      )}

      {/* Gallery Panel (idle / complete) */}
      {(state === 'idle' || state === 'complete') && gallery.length > 0 && (
        <div className="panel blind-gallery-panel">
          <div className="blind-gallery-header">
            <span className="panel-title">GALLERY</span>
            <span className="blind-gallery-count">{gallery.length} painting{gallery.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="blind-gallery-grid">
            {gallery.map((entry) => (
              <div
                className="blind-gallery-thumb"
                key={entry.id}
                onClick={() => setViewingEntry(entry)}
              >
                <img src={entry.thumbData} alt={`Painting from ${new Date(entry.date).toLocaleDateString()}`} />
                <div className="blind-gallery-thumb-info">
                  <span>{entry.gestures}g</span>
                  <span style={{ color: BAND_COLORS[entry.dominantBand] }}>
                    {BAND_LABELS[entry.dominantBand]?.slice(0, 3) ?? ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Gallery Viewer Modal */}
      {viewingEntry && (
        <div className="blind-modal-overlay" onClick={() => setViewingEntry(null)}>
          <div className="blind-modal blind-gallery-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="blind-gallery-viewer-content">
              <img src={viewingEntry.imageData} alt="Brain painting" className="blind-gallery-viewer-img" />
              <div className="blind-gallery-viewer-meta">
                <span>{new Date(viewingEntry.date).toLocaleDateString()}</span>
                <span>{viewingEntry.gestures} gestures</span>
                <span>{formatMs(viewingEntry.paintTimeMs)} paint</span>
                <span style={{ color: BAND_COLORS[viewingEntry.dominantBand] }}>
                  {BAND_LABELS[viewingEntry.dominantBand]}
                </span>
                {viewingEntry.jawClenches > 0 && (
                  <span style={{ color: '#f472b6' }}>{viewingEntry.jawClenches} stamps</span>
                )}
              </div>
              <div className="blind-gallery-viewer-actions">
                <a
                  className="blind-modal-save"
                  href={viewingEntry.imageData}
                  download={`blindsight-${viewingEntry.date.slice(0, 10)}.jpg`}
                >
                  Download
                </a>
                <button
                  className="blind-gallery-delete"
                  onClick={() => handleDeleteGalleryEntry(viewingEntry.id)}
                >
                  Delete
                </button>
                <button className="blind-modal-dismiss" onClick={() => setViewingEntry(null)}>
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
