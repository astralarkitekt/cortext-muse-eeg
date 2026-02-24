import { useEffect, useRef } from 'react';
import { initMonitor, destroyMonitor } from '../monitor-engine';

export function Monitor() {
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      // Defer to ensure DOM is rendered
      requestAnimationFrame(() => initMonitor());
    }
    return () => {
      destroyMonitor();
      initialized.current = false;
    };
  }, []);

  return (
    <div className="dashboard">
      {/* ── Waveform Panel ── */}
      <div className="panel waveform-panel">
        <div className="panel-header">
          <span className="panel-title">EEG Waveforms</span>
          <div className="channel-labels">
            <div className="channel-label">
              <div className="channel-dot" style={{ background: 'var(--channel-tp9)' }} />TP9
            </div>
            <div className="channel-label">
              <div className="channel-dot" style={{ background: 'var(--channel-af7)' }} />AF7
            </div>
            <div className="channel-label">
              <div className="channel-dot" style={{ background: 'var(--channel-af8)' }} />AF8
            </div>
            <div className="channel-label">
              <div className="channel-dot" style={{ background: 'var(--channel-tp10)' }} />TP10
            </div>
          </div>
        </div>
        <div className="panel-body" style={{ position: 'relative' }}>
          <div className="idle-overlay" id="idle-overlay">
            <div className="idle-icon">
              <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 4a2 2 0 1 1-2 2 2 2 0 0 1 2-2Zm4 10H8s0-4 4-4 4 4 4 4Z" /></svg>
            </div>
            <div className="idle-text">AWAITING SIGNAL</div>
          </div>
          <canvas id="eeg-canvas" height={480} />
        </div>
      </div>

      {/* ── Frequency Bands ── */}
      <div className="panel bands-panel">
        <div className="panel-header">
          <span className="panel-title">Frequency Bands</span>
        </div>
        <div className="panel-body" id="bands-container">
          {([
            { key: 'delta', sym: 'δ', label: 'Delta', range: '0.5–4 Hz', color: 'var(--accent-delta)' },
            { key: 'theta', sym: 'θ', label: 'Theta', range: '4–8 Hz', color: 'var(--accent-theta)' },
            { key: 'alpha', sym: 'α', label: 'Alpha', range: '8–13 Hz', color: 'var(--accent-alpha)' },
            { key: 'beta', sym: 'β', label: 'Beta', range: '13–30 Hz', color: 'var(--accent-beta)' },
            { key: 'gamma', sym: 'γ', label: 'Gamma', range: '30–100 Hz', color: 'var(--accent-gamma)' },
          ] as const).map((b) => (
            <div className="band-row" key={b.key}>
              <span className="band-label" style={{ color: b.color }}>{b.sym} {b.label}</span>
              <span className="band-range">{b.range}</span>
              <div className="band-bar-container">
                <div className="band-bar" id={`band-${b.key}`} style={{ background: b.color }} />
              </div>
              <span className="band-value" id={`val-${b.key}`}>—</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Metrics ── */}
      <div className="panel metrics-panel">
        <div className="panel-header">
          <span className="panel-title">Metrics</span>
        </div>
        <div className="panel-body">
          <div className="metric-grid">
            <div className="metric-card">
              <div className="metric-value" id="metric-focus" style={{ color: 'var(--accent-beta)' }}>—</div>
              <div className="metric-label">Focus</div>
            </div>
            <div className="metric-card">
              <div className="metric-value" id="metric-calm" style={{ color: 'var(--accent-alpha)' }}>—</div>
              <div className="metric-label">Calm</div>
            </div>
            <div className="metric-card">
              <div className="metric-value" id="metric-samples" style={{ color: 'var(--text-secondary)' }}>0</div>
              <div className="metric-label">Samples</div>
            </div>
            <div className="metric-card">
              <div className="metric-value" id="metric-time" style={{ color: 'var(--text-secondary)' }}>0:00</div>
              <div className="metric-label">Session</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Console ── */}
      <div className="panel log-area">
        <div className="panel-header">
          <span className="panel-title">Console</span>
        </div>
        <div className="panel-body">
          <div className="log-content" id="log-content">
            <div className="info">CORTEX v0.2.0 — Muse EEG Observatory</div>
            <div className="info">Ready. Click CONNECT and select your Muse headband.</div>
            <div className="info">Requires Chrome or Edge (Web Bluetooth API).</div>
          </div>
        </div>
      </div>

      {/* ── Actions ── */}
      <div className="panel actions-panel">
        <div className="panel-header">
          <span className="panel-title">Actions</span>
        </div>
        <div className="panel-body">
          <div style={{ position: 'relative' }}>
            <button className="action-btn" id="export-btn" disabled>
              <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Export
            </button>
            <div className="export-dropdown" id="export-dropdown">
              <button className="export-option" data-seconds="30">Last 30 seconds</button>
              <button className="export-option" data-seconds="60">Last 1 minute</button>
              <button className="export-option" data-seconds="120">Last 2 minutes</button>
              <button className="export-option" data-seconds="300">Last 5 minutes</button>
              <button className="export-option" data-seconds="0">Entire session</button>
            </div>
          </div>
          <div className="audio-row">
            <button className="action-btn" id="audio-load-btn">
              <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
              Load
            </button>
            <button className="action-btn" id="audio-eject-btn" disabled>
              <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              Eject
            </button>
          </div>
          <button className="action-btn" id="audio-play-btn" disabled>
            <svg id="play-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3" /></svg>
            <svg id="pause-icon" viewBox="0 0 24 24" style={{ display: 'none' }}><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
            <span id="audio-play-label">Play</span>
          </button>
          <div className="audio-filename" id="audio-filename"></div>
          <input type="file" id="audio-file-input" accept="audio/*" style={{ display: 'none' }} />
        </div>
      </div>
    </div>
  );
}
