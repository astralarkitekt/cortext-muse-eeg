import { useState } from 'react';
import { Monitor } from './pages/Monitor';
import { Neuro } from './pages/Neuro';
import { Analyze } from './pages/Analyze';
import { Blindsight } from './pages/Blindsight';

type Tab = 'monitor' | 'neuro' | 'analyze' | 'blindsight';

export function App() {
  const [activeTab, setActiveTab] = useState<Tab>('monitor');

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <h1>Cortex</h1>
          <span className="version">v0.2.0</span>
        </div>

        <nav className="tab-nav">
          <button
            className={`tab-btn${activeTab === 'monitor' ? ' active' : ''}`}
            onClick={() => setActiveTab('monitor')}
          >
            Monitor
          </button>
          <button
            className={`tab-btn${activeTab === 'analyze' ? ' active' : ''}`}
            onClick={() => setActiveTab('analyze')}
          >
            Analyze
          </button>
          <button
            className={`tab-btn${activeTab === 'neuro' ? ' active' : ''}`}
            onClick={() => setActiveTab('neuro')}
          >
            Neuro
          </button>
          <button
            className={`tab-btn${activeTab === 'blindsight' ? ' active' : ''}`}
            onClick={() => setActiveTab('blindsight')}
          >
            Blindsight
          </button>
        </nav>

        <div className="status-bar">
          <div className="status-indicator">
            <div className="status-dot" id="status-dot"></div>
            <span id="status-text">disconnected</span>
          </div>
          <div className="electrode-quality" id="electrode-quality">
            <div className="electrode-pip" title="TP9"></div>
            <div className="electrode-pip" title="AF7"></div>
            <div className="electrode-pip" title="AF8"></div>
            <div className="electrode-pip" title="TP10"></div>
          </div>
          <button className="connect-btn" id="connect-btn">Connect</button>
        </div>
      </header>

      <div style={{ display: activeTab === 'monitor' ? undefined : 'none' }}><Monitor /></div>
      <div style={{ display: activeTab === 'neuro' ? undefined : 'none' }}><Neuro /></div>
      <div style={{ display: activeTab === 'analyze' ? undefined : 'none' }}><Analyze /></div>
      <div style={{ display: activeTab === 'blindsight' ? undefined : 'none' }}><Blindsight /></div>
    </div>
  );
}
