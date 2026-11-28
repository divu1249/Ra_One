import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, ShieldAlert, GitCompare, Trash2, TerminalSquare, ShieldCheck, Cpu, Sliders } from 'lucide-react';
import HudHeader from './components/HudHeader';
import LeftNavRail from './components/LeftNavRail';
import HudFooter from './components/HudFooter';
import NeuralCoreCanvas from './components/NeuralCoreCanvas';
import SecondaryMonitorCanvas from './components/SecondaryMonitorCanvas';
import WaveformCanvas from './components/WaveformCanvas';
import HydraStatusBar from './components/HydraStatusBar';
import NeuralMatrix from './components/NeuralMatrix';
import TelemetryConsole from './components/TelemetryConsole';
import EpisodicMemoryPanel from './components/EpisodicMemoryPanel';
import {
  getNeuralChannelForEvent,
  INITIAL_RUN_METRICS,
  parseSseBuffer,
  reduceSseEvent,
} from './utils/streamState';

const DEFAULT_THOUGHT_LINES = [
  '> Analyzing context...',
  '> Evaluating options...',
  '> Formulating response...',
  '> Synthesizing output...',
];

const BANNER_LABELS = {
  idle: 'I D L E . . .',
  memory: 'R E C A L L I N G . . .',
  actor: 'T H I N K I N G . . .',
  sandbox: 'E X E C U T I N G . . .',
  mutate: 'M U T A T I N G . . .',
  critic: 'A U D I T I N G . . .',
  verified: 'A N S W E R I N G . . .',
  error: 'F A U L T   A L E R T',
};

function formatTimestamp() {
  return new Date().toLocaleTimeString([], { hour12: false });
}

function summarizeThoughtLine(entry) {
  const clean = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '> Signal received...';
  const shortened = clean.length > 74 ? `${clean.slice(0, 71)}...` : clean;
  return `> ${shortened}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('monitor');
  const [input, setInput] = useState('');
  const [maxIterations, setMaxIterations] = useState(5);
  const [logs, setLogs] = useState([]);
  const [codeArtifacts, setCodeArtifacts] = useState([]);
  const [activeCodeIndex, setActiveCodeIndex] = useState(0);
  const [runMetrics, setRunMetrics] = useState(INITIAL_RUN_METRICS);
  const [isRunning, setIsRunning] = useState(false);

  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [episodes, setEpisodes] = useState([]);
  const [flushingQueue, setFlushingQueue] = useState(false);

  // HUD visual preferences (persisted locally in state, no API keys)
  const [crtEnabled, setCrtEnabled] = useState(true);
  const [parallaxEnabled, setParallaxEnabled] = useState(true);
  const [pulseTimestamps, setPulseTimestamps] = useState({
    cortex: 0,
    memory: 0,
    emotion: 0,
    decision: 0,
  });

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const res = await fetch('/health');
      if (res.ok) {
        setHealth(await res.json());
      }
    } catch {
      // Keep prior snapshot on transient error
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const fetchMemory = useCallback(async () => {
    try {
      const res = await fetch('/memory');
      if (res.ok) {
        const data = await res.json();
        setEpisodes(Array.isArray(data.episodes) ? data.episodes : []);
      }
    } catch {
      // Ignore memory sync failure
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    fetchMemory();
  }, [fetchHealth, fetchMemory]);

  const handleFlushQueue = async () => {
    setFlushingQueue(true);
    try {
      const res = await fetch('/queue/flush', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setLogs((prev) => [
          ...prev,
          {
            type: 'telemetry',
            content: `[QUEUE FLUSH] Flushed ${data.flushed} queued task(s).`,
            time: formatTimestamp(),
          },
        ]);
        await fetchHealth();
        await fetchMemory();
      }
    } finally {
      setFlushingQueue(false);
    }
  };

  const executeDirective = async (directiveText, mode = 'live') => {
    const trimmed = directiveText.trim();
    if (!trimmed || isRunning) return;

    setIsRunning(true);
    setRunMetrics({
      ...INITIAL_RUN_METRICS,
      stage: 'memory',
      maxIterations,
    });
    setPulseTimestamps((prev) => ({ ...prev, memory: Date.now(), cortex: Date.now() }));

    setLogs((prev) => [
      ...prev,
      { type: 'user', content: trimmed, time: formatTimestamp() },
    ]);

    if (mode === 'live') {
      setInput('');
    }

    try {
      const response = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          max_iterations: maxIterations,
          mode,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseBuffer(buffer);
        buffer = remainder;

        for (const ev of events) {
          setRunMetrics((prev) => reduceSseEvent(prev, ev));

          const channel = getNeuralChannelForEvent(ev);
          setPulseTimestamps((prev) => ({
            ...prev,
            [channel]: Date.now(),
          }));

          if (ev.type === 'code') {
            setCodeArtifacts((prev) => {
              const next = [...prev, { content: ev.content, time: formatTimestamp() }];
              setActiveCodeIndex(next.length - 1);
              return next;
            });
          } else {
            setLogs((prev) => [
              ...prev,
              { type: ev.type, content: ev.content, time: formatTimestamp() },
            ]);
          }
        }
      }

      await fetchHealth();
      await fetchMemory();
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        {
          type: 'error',
          content: `CRITICAL FAILURE: H.A.R.T. link error (${err instanceof Error ? err.message : String(err)}).`,
          time: formatTimestamp(),
        },
      ]);
      setRunMetrics((prev) => ({ ...prev, stage: 'error' }));
      setPulseTimestamps((prev) => ({ ...prev, emotion: Date.now() }));
    } finally {
      setIsRunning(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    executeDirective(input, 'live');
  };

  const handleClear = () => {
    setLogs([]);
    setCodeArtifacts([]);
    setActiveCodeIndex(0);
    setRunMetrics(INITIAL_RUN_METRICS);
  };

  // Dynamic HUD Telemetry Derivations
  const telemetryReadout = useMemo(() => {
    const stage = runMetrics.stage;
    if (stage === 'actor' || stage === 'mutate') {
      return { load: '99.4%', bpm: 112, temp: '38.4°C', sync: '99.6%' };
    }
    if (stage === 'sandbox' || stage === 'critic') {
      return { load: '98.7%', bpm: 104, temp: '37.9°C', sync: '99.8%' };
    }
    if (stage === 'memory') {
      return { load: '98.1%', bpm: 92, temp: '37.4°C', sync: '99.9%' };
    }
    if (stage === 'error') {
      return { load: '84.2%', bpm: 126, temp: '39.2°C', sync: '91.4%' };
    }
    return { load: '97.6%', bpm: 84, temp: '37.1°C', sync: '99.9%' };
  }, [runMetrics.stage]);

  const thoughtLines = useMemo(() => {
    const relevant = logs.filter((l) => l.type !== 'user');
    if (relevant.length === 0) return DEFAULT_THOUGHT_LINES;
    return relevant.slice(-4).map(summarizeThoughtLine);
  }, [logs]);

  const eqHeights = useMemo(() => {
    if (runMetrics.stage === 'actor' || runMetrics.stage === 'mutate') return [72, 92, 58, 96, 80];
    if (runMetrics.stage === 'sandbox' || runMetrics.stage === 'critic') return [64, 82, 74, 68, 88];
    if (runMetrics.stage === 'verified') return [48, 76, 88, 62, 70];
    return [30, 56, 78, 42, 64];
  }, [runMetrics.stage]);

  const statusOnlineText = health ? String(health.status).toUpperCase() : 'CONNECTING';
  const activeProviderRaw = runMetrics.activeProvider || health?.active_provider || 'standby';
  const routedVia =
    runMetrics.routedVia ||
    (activeProviderRaw === 'freellmapi' ? health?.last_routed_via : null);
  const activeProvider = activeProviderRaw.toUpperCase();
  const activeProviderDisplay = routedVia ? `${activeProvider} (${routedVia})` : activeProvider;
  const tierLabel = (health?.active_tier || 'TIER_0').replace('_', ' ');
  const latencyValue = runMetrics.lastLatencyMs !== null ? `${Math.round(runMetrics.lastLatencyMs)} ms` : '1.2 ms';
  const throughputValue = isRunning ? '24.8 Gbps' : '21.4 Gbps';
  const packetLossValue =
    runMetrics.failoverCount > 0 ? `${(runMetrics.failoverCount * 0.12).toFixed(2)}%` : '0.01%';

  const hazardProgressPct = isRunning
    ? Math.min(95, Math.max(28, Math.round((Math.max(1, runMetrics.iteration) / Math.max(1, runMetrics.maxIterations)) * 88)))
    : runMetrics.stage === 'verified'
    ? 100
    : 34;

  const bannerSubLabel = isRunning
    ? `HYDRA ${activeProviderDisplay} // ITER ${runMetrics.iteration}/${runMetrics.maxIterations} //`
    : 'NEURAL LINK STABILIZED //';

  const providers = health?.providers ?? [];

  return (
    <div
      className={`${
        activeTab === 'monitor' ? 'min-h-screen lg:h-screen lg:overflow-hidden' : 'min-h-screen'
      } raone-ambient-bg text-[#e6eaf0] flex flex-col relative overflow-x-hidden`}
    >
      {crtEnabled && (
        <div
          className="pointer-events-none fixed inset-0 z-0 crt-scanlines opacity-85"
          aria-hidden="true"
        />
      )}

      <HudHeader />

      {/* Main Workspace Frame */}
      <div className="flex-1 relative z-10 w-full max-w-[1600px] mx-auto px-3 py-2.5 lg:px-5 lg:py-3 flex flex-col lg:flex-row gap-3 min-h-0">
        <LeftNavRail
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          logsCount={logs.length}
          codeCount={codeArtifacts.length}
        />

        <main className="flex-1 min-w-0 flex flex-col gap-2.5 min-h-0">
          {activeTab === 'monitor' && (
            <>
              {/* 3-Column Reference HUD Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_288px] xl:grid-cols-[258px_minmax(0,1fr)_316px] gap-3 flex-1 min-h-0">
                {/* LEFT-MIDDLE TELEMETRY COLUMN */}
                <div className="flex flex-col gap-2.5 min-h-0">
                  {/* Card 1: NEURAL ACTIVITY */}
                  <section
                    aria-label="Neural Activity"
                    className="hud-chamfer hud-specular-top relative px-4 py-3 flex flex-col justify-between"
                  >
                    <h2 className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#c2c8d2]">
                      NEURAL ACTIVITY
                    </h2>

                    <div className="mt-1 flex items-baseline gap-2">
                      <span
                        className="text-3xl font-semibold tracking-tight text-[#e6eaf0] tabular-nums"
                        style={{ fontFamily: 'var(--font-hud)' }}
                      >
                        {telemetryReadout.load}
                      </span>
                      <span className="text-xs crimson-glow-text" aria-hidden="true">
                        ▲
                      </span>
                    </div>

                    <div className="h-[48px] my-1 w-full">
                      <WaveformCanvas
                        variant="eeg"
                        spikeLevel={isRunning ? 0.72 : 0.42}
                        pulseAt={pulseTimestamps.cortex}
                        isRunning={isRunning}
                      />
                    </div>

                    <div className="pt-1 border-t border-white/10 font-mono text-[11px] tracking-wider text-[#9ca4b2] tabular-nums space-y-0.5">
                      <div>
                        BPM <span className="text-[#e6eaf0]">{telemetryReadout.bpm}</span>
                        <span className="mx-2 text-[#4c5360]">|</span>
                        TEMP <span className="text-[#e6eaf0]">{telemetryReadout.temp}</span>
                      </div>
                      <div>
                        SYNC <span className="text-[#e6eaf0]">{telemetryReadout.sync}</span>
                      </div>
                    </div>
                  </section>

                  {/* Card 2: SYSTEM STATUS */}
                  <section
                    aria-label="System Status"
                    className="hud-chamfer hud-specular-top relative px-4 py-3 flex flex-col gap-2"
                  >
                    <h2 className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#c2c8d2]">
                      SYSTEM STATUS
                    </h2>

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            health?.status === 'online'
                              ? 'bg-[#ff1e2d] shadow-[0_0_12px_#ff1e2d]'
                              : 'bg-amber-400 shadow-[0_0_10px_#f59e0b]'
                          }`}
                          aria-hidden="true"
                        />
                        <span
                          className="text-xs font-bold tracking-[0.2em] crimson-glow-text"
                          data-testid="health-status"
                        >
                          {statusOnlineText}
                        </span>
                      </div>
                      <span
                        className="text-[10px] font-mono tracking-wider text-[#7c8490] uppercase"
                        data-testid="active-tier"
                      >
                        {tierLabel}
                      </span>
                    </div>

                    <dl className="space-y-1.5 font-mono text-[11px] tabular-nums border-t border-white/10 pt-2">
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[#7c8490] tracking-wider">LATENCY</dt>
                        <dd className="text-[#e6eaf0]">{latencyValue}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[#7c8490] tracking-wider">THROUGHPUT</dt>
                        <dd className="text-[#e6eaf0]">{throughputValue}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[#7c8490] tracking-wider">PACKET LOSS</dt>
                        <dd className="text-[#e6eaf0]">{packetLossValue}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-[#7c8490] tracking-wider">HYDRA NODE</dt>
                        <dd className="text-[#ff2a38] font-semibold truncate max-w-[155px]" title={activeProviderDisplay}>
                          {activeProviderDisplay}
                        </dd>
                      </div>
                    </dl>
                  </section>

                  {/* Card 3: NEURAL FLOWS */}
                  <section
                    aria-label="Neural Flows"
                    className="hud-chamfer hud-specular-top relative px-4 py-3 flex-1 flex flex-col justify-between min-h-[140px]"
                  >
                    <h2 className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#c2c8d2] mb-1.5">
                      NEURAL FLOWS
                    </h2>

                    <div className="space-y-1.5 my-auto">
                      {[
                        { key: 'cortex', label: 'Cortex', phase: 0.2 },
                        { key: 'memory', label: 'Memory', phase: 1.5 },
                        { key: 'emotion', label: 'Emotion', phase: 2.7 },
                        { key: 'decision', label: 'Decision', phase: 4.1 },
                      ].map((row) => (
                        <div key={row.key} className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-2">
                          <span className="text-xs text-[#9aa2b0] tracking-wide">{row.label}</span>
                          <div className="h-[20px] w-full">
                            <WaveformCanvas
                              variant="sine"
                              spikeLevel={0.38}
                              pulseAt={pulseTimestamps[row.key]}
                              phaseOffset={row.phase}
                              isRunning={isRunning}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>

                {/* CENTER VIEWPORT: OCTAGONAL PROCEDURAL 3D VOXEL CORE */}
                <section
                  aria-label="Neural Core Viewport"
                  data-testid="neural-core-viewport"
                  data-stage={runMetrics.stage}
                  className="hud-chamfer-oct relative min-h-[340px] lg:min-h-0 flex flex-col overflow-hidden"
                >
                  {/* Specular corner lens glints */}
                  <span
                    className="pointer-events-none absolute top-2 left-8 w-10 h-[2px] bg-gradient-to-r from-white/80 to-transparent"
                    aria-hidden="true"
                  />
                  <span
                    className="pointer-events-none absolute bottom-2 right-8 w-10 h-[2px] bg-gradient-to-l from-white/80 to-transparent"
                    aria-hidden="true"
                  />
                  <div className="pointer-events-none absolute top-2.5 inset-x-6 flex items-center justify-between text-[10px] font-mono tracking-[0.22em] text-[#7c8490] uppercase z-10">
                    <span>CORE // VOXEL-ENTITY</span>
                    <span className="text-[#ff2a38]">
                      LOOP {runMetrics.iteration}/{runMetrics.maxIterations}
                    </span>
                  </div>

                  <div className="flex-1 w-full h-full min-h-[320px] lg:min-h-0">
                    <NeuralCoreCanvas
                      stage={runMetrics.stage}
                      isRunning={isRunning}
                      parallaxEnabled={parallaxEnabled}
                    />
                  </div>
                </section>

                {/* RIGHT TELEMETRY COLUMN */}
                <div className="flex flex-col gap-2.5 min-h-0">
                  {/* Card 1: THOUGHT PROCESS + Hazard Progress Bar */}
                  <section
                    aria-label="Thought Process"
                    className="hud-chamfer hud-specular-top hud-specular-bottom relative px-4 py-3 flex flex-col justify-between min-h-[176px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-[11px] font-semibold tracking-[0.22em] uppercase text-[#c2c8d2]">
                        THOUGHT PROCESS
                      </h2>
                      <span className="text-[10px] font-mono text-[#ff2a38] uppercase">
                        {isRunning ? 'STREAMING' : 'READY'}
                      </span>
                    </div>

                    <div
                      className="my-2 space-y-1.5 font-mono text-xs text-[#9aa2b0] leading-snug"
                      data-testid="thought-process-feed"
                    >
                      {thoughtLines.map((line, i) => (
                        <div
                          key={i}
                          className={`truncate ${
                            i === thoughtLines.length - 1 && logs.length > 0
                              ? 'text-[#e6eaf0]'
                              : ''
                          }`}
                        >
                          <span className="text-[#ff1e2d] mr-1.5">&gt;</span>
                          <span>{line.replace(/^>\s*/, '')}</span>
                        </div>
                      ))}
                    </div>

                    {/* Diagonal Crimson Hazard Progress Bar */}
                    <div className="h-3.5 w-full bg-[#06070a] border border-white/15 p-0.5">
                      <div
                        className={`h-full hazard-bar-fill transition-all duration-300 ${
                          isRunning ? 'hazard-bar-active' : 'hazard-bar-idle'
                        }`}
                        style={{ width: `${hazardProgressPct}%` }}
                      />
                    </div>
                  </section>

                  {/* Card 2: Status Banner */}
                  <section
                    aria-label="Neural Link Status Banner"
                    className="hud-chamfer hud-specular-top hud-specular-bottom relative px-4 py-3.5 text-center flex flex-col items-center justify-center"
                  >
                    <div
                      className="text-xs xl:text-sm font-bold tracking-[0.2em] crimson-glow-text uppercase whitespace-nowrap"
                      style={{ fontFamily: 'var(--font-display)' }}
                      data-testid="hud-status-banner"
                    >
                      {BANNER_LABELS[runMetrics.stage] || BANNER_LABELS.idle}
                    </div>
                    <div className="mt-1 text-[10px] font-mono tracking-[0.24em] text-[#7c8490] uppercase">
                      {bannerSubLabel}
                    </div>
                  </section>

                  {/* Card 3: Secondary Angled Core Monitor + 5-Column Compute Bars */}
                  <section
                    aria-label="Secondary Profile Monitor"
                    className="hud-chamfer hud-specular-bottom relative p-2.5 flex-1 min-h-[150px] grid grid-cols-[minmax(0,1fr)_68px] gap-2 items-stretch"
                  >
                    <div className="border border-white/10 bg-black/50 overflow-hidden min-h-[120px]">
                      <SecondaryMonitorCanvas stage={runMetrics.stage} isRunning={isRunning} />
                    </div>

                    {/* 5-Column Vertical Equalizer Bars with Micro Scale */}
                    <div className="flex items-end justify-between gap-1.5 px-1 py-1 border border-white/10 bg-black/40">
                      {eqHeights.map((pct, idx) => (
                        <div
                          key={idx}
                          className="relative flex-1 h-full bg-[#120608] border border-white/10 flex flex-col justify-end overflow-hidden"
                        >
                          <div
                            className="w-full bg-gradient-to-t from-[#8a0814] via-[#ff1e2d] to-[#ff858d] transition-all duration-200 shadow-[0_0_8px_rgba(255,30,45,0.65)]"
                            style={{ height: `${pct}%` }}
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </>
          )}

          {activeTab === 'telemetry' && (
            <div className="flex flex-col gap-3.5">
              <HydraStatusBar
                health={health}
                healthLoading={healthLoading}
                runMetrics={runMetrics}
                onRefreshHealth={fetchHealth}
                onFlushQueue={handleFlushQueue}
                flushingQueue={flushingQueue}
              />
              <EpisodicMemoryPanel
                episodes={episodes}
                recalledNotes={runMetrics.recalledNotes}
                onRefreshMemory={fetchMemory}
              />
            </div>
          )}

          {activeTab === 'diagnostics' && (
            <div className="flex flex-col gap-3.5">
              <HydraStatusBar
                health={health}
                healthLoading={healthLoading}
                runMetrics={runMetrics}
                onRefreshHealth={fetchHealth}
                onFlushQueue={handleFlushQueue}
                flushingQueue={flushingQueue}
              />
              <NeuralMatrix
                stage={runMetrics.stage}
                iteration={runMetrics.iteration}
                maxIterations={runMetrics.maxIterations}
                isRunning={isRunning}
              />
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="flex flex-col gap-3.5 flex-1">
              <TelemetryConsole
                logs={logs}
                codeArtifacts={codeArtifacts}
                activeCodeIndex={activeCodeIndex}
                onSelectCodeIndex={setActiveCodeIndex}
              />
              <EpisodicMemoryPanel
                episodes={episodes}
                recalledNotes={runMetrics.recalledNotes}
                onRefreshMemory={fetchMemory}
              />
            </div>
          )}

          {activeTab === 'settings' && (
            <section
              aria-label="Terminal Configuration"
              className="hud-chamfer hud-specular-top relative p-5 space-y-5"
            >
              <div className="flex items-center gap-2.5 border-b border-white/10 pb-3">
                <Sliders size={15} className="text-[#ff1e2d]" />
                <h2 className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0]">
                  NEURAL TERMINAL CONFIGURATION
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs font-mono">
                <div className="border border-white/10 bg-black/40 p-4 space-y-3">
                  <div className="text-[#ff2a38] tracking-[0.18em] uppercase font-semibold">
                    DISPLAY &amp; CORE FX
                  </div>
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="text-[#c5ccd8]">CRT Scanline Lattice Overlay</span>
                    <input
                      type="checkbox"
                      checked={crtEnabled}
                      onChange={(e) => setCrtEnabled(e.target.checked)}
                      className="accent-[#ff1e2d] w-4 h-4"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3 cursor-pointer">
                    <span className="text-[#c5ccd8]">3D Voxel Core Mouse Parallax</span>
                    <input
                      type="checkbox"
                      checked={parallaxEnabled}
                      onChange={(e) => setParallaxEnabled(e.target.checked)}
                      className="accent-[#ff1e2d] w-4 h-4"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-[#c5ccd8]">Default Actor-Critic Max Loops</span>
                    <select
                      value={maxIterations}
                      onChange={(e) => setMaxIterations(Number(e.target.value))}
                      className="bg-[#090a0e] border border-white/20 text-[#e6eaf0] px-2.5 py-1"
                    >
                      {[1, 2, 3, 5, 8, 10].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="border border-white/10 bg-black/40 p-4 space-y-2.5">
                  <div className="flex items-center gap-2 text-[#ff2a38] tracking-[0.18em] uppercase font-semibold">
                    <Cpu size={14} />
                    <span>SERVER HYDRA ENVIRONMENT (READ-ONLY)</span>
                  </div>
                  <p className="text-[11px] text-[#7c8490] leading-relaxed">
                    Provider credentials are managed strictly server-side. Active provider pool reported by{' '}
                    <span className="text-[#e6eaf0]">/health</span>:
                  </p>
                  <div className="space-y-1.5 pt-1">
                    {providers.length === 0 ? (
                      <div className="text-[#7c8490]">Awaiting /health snapshot...</div>
                    ) : (
                      providers.map((p) => {
                        const isFree = p.name === 'freellmapi';
                        const freeState = health?.freellmapi;
                        const label = isFree && freeState
                          ? freeState === 'ready'
                            ? `READY${health?.freellmapi_models_available ? ` (${health.freellmapi_models_available})` : ''}`
                            : freeState.toUpperCase()
                          : !p.configured
                          ? 'UNCONFIGURED'
                          : p.healthy
                          ? 'READY'
                          : 'FAULT';
                        const colorClass = isFree && freeState
                          ? freeState === 'unconfigured'
                            ? 'text-[#5e6573]'
                            : freeState === 'ready'
                            ? 'text-[#ff2a38]'
                            : 'text-amber-400'
                          : !p.configured
                          ? 'text-[#5e6573]'
                          : p.healthy
                          ? 'text-[#ff2a38]'
                          : 'text-amber-400';
                        return (
                          <div
                            key={p.name}
                            className="flex items-center justify-between border border-white/10 px-3 py-1.5 bg-[#090a0e]/80"
                          >
                            <span className="uppercase text-[#e6eaf0]">{p.name}</span>
                            <span className={colorClass}>{label}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'security' && (
            <section
              aria-label="Security and Sandbox Isolation"
              className="hud-chamfer hud-specular-top relative p-5 space-y-4"
            >
              <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex items-center gap-2.5">
                  <ShieldCheck size={15} className="text-[#ff1e2d]" />
                  <h2 className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0]">
                    SANDBOX &amp; ADVERSARIAL CRITIC GOVERNANCE
                  </h2>
                </div>
                <span className="text-[11px] font-mono text-[#ff2a38] uppercase">
                  ZERO-TRUST ACTIVE
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 font-mono text-xs">
                <div className="border border-white/10 bg-black/45 p-4 space-y-1.5">
                  <div className="text-[#7c8490] uppercase">SUBPROCESS SANDBOX</div>
                  <div className="text-sm font-semibold text-[#e6eaf0]">
                    {health?.sandbox?.ready ? 'ISOLATED PYTHON3 READY' : 'CHECKING RUNTIME'}
                  </div>
                  <p className="text-[11px] text-[#7c8490] leading-relaxed">
                    Every Actor kernel runs in an ephemeral subprocess with strict timeout isolation and traceback capture.
                  </p>
                </div>

                <div className="border border-white/10 bg-black/45 p-4 space-y-1.5">
                  <div className="text-[#7c8490] uppercase">ADVERSARIAL CRITIC GATE</div>
                  <div className="text-sm font-semibold text-[#ff2a38]">STRICT CRITICVERDICT</div>
                  <p className="text-[11px] text-[#7c8490] leading-relaxed">
                    Exit 0 never auto-passes. Critic audits assertion coverage, edge-case handling, and memory isolation.
                  </p>
                </div>

                <div className="border border-white/10 bg-black/45 p-4 space-y-1.5">
                  <div className="text-[#7c8490] uppercase">EPISODIC MEMORY &amp; QUEUE</div>
                  <div className="text-sm font-semibold text-[#e6eaf0] uppercase">
                    {health?.episodic_memory?.backend ?? 'SQLITE'} ({health?.episodic_memory?.episode_count ?? episodes.length})
                  </div>
                  <p className="text-[11px] text-[#7c8490] leading-relaxed">
                    Offline queue depth: {health?.offline_queue_depth ?? 0}.
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Sleek Integrated HUD Directive Command Strip */}
          <section
            aria-label="Directive Controls"
            className="hud-chamfer hud-specular-top relative px-4 py-2.5 flex flex-col gap-2"
          >
            <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
              <div className="flex-1 flex items-center gap-2 bg-black/55 border border-white/15 focus-within:border-[#ff1e2d] px-3 py-1.5">
                <span className="font-mono text-xs text-[#ff1e2d] font-bold select-none">&gt;</span>
                <label htmlFor="directive-input" className="sr-only">
                  Agent directive
                </label>
                <input
                  id="directive-input"
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Enter engineering task or Python verification directive..."
                  className="w-full bg-transparent text-[#e6eaf0] text-xs font-mono placeholder-[#5e6573] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <label htmlFor="max-iterations-select" className="text-[11px] font-mono text-[#7c8490] uppercase">
                  LOOPS
                </label>
                <select
                  id="max-iterations-select"
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Number(e.target.value))}
                  className="bg-black/60 border border-white/15 text-[#e6eaf0] px-2 py-1.5 text-xs font-mono focus:outline-none focus:border-[#ff1e2d]"
                >
                  {[1, 2, 3, 5, 8, 10].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  disabled={isRunning || !input.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold tracking-wider uppercase bg-[#c8101e] hover:bg-[#ff1e2d] text-white border border-[#ff4f5b]/50 shadow-[0_0_14px_rgba(255,30,45,0.4)] transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  <Play size={13} />
                  <span>{isRunning ? 'RUNNING...' : 'RUN TASK'}</span>
                </button>

                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() =>
                    executeDirective('Compute first 5 Fibonacci primes with traceback self-heal verification', 'drill')
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono uppercase bg-black/55 hover:bg-[#ff1e2d]/15 text-[#c5ccd8] border border-white/15 hover:border-[#ff1e2d]/50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  <ShieldAlert size={12} className="text-[#ff2a38]" />
                  <span>SELF-HEAL DRILL</span>
                </button>

                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() =>
                    executeDirective('Simulate staged mutation diff on ra_one_core/sandbox_probe.py', 'drill')
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono uppercase bg-black/55 hover:bg-[#ff1e2d]/15 text-[#c5ccd8] border border-white/15 hover:border-[#ff1e2d]/50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
                >
                  <GitCompare size={12} className="text-[#ff2a38]" />
                  <span>MUTATION DRILL</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('logs')}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-mono uppercase bg-black/55 hover:bg-[#ff1e2d]/15 text-[#c5ccd8] border border-white/15 hover:border-[#ff1e2d]/50 transition-colors whitespace-nowrap shrink-0"
                >
                  <TerminalSquare size={12} className="text-[#ff2a38]" />
                  <span>LOGS{codeArtifacts.length > 0 ? ` (${codeArtifacts.length})` : ''}</span>
                </button>

                <button
                  type="button"
                  onClick={handleClear}
                  aria-label="Clear Console"
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono uppercase text-[#7c8490] hover:text-[#e6eaf0] bg-black/45 border border-white/10 transition-colors whitespace-nowrap shrink-0"
                >
                  <Trash2 size={12} />
                  <span>CLEAR</span>
                </button>
              </div>
            </form>
          </section>
        </main>
      </div>

      <HudFooter
        stage={runMetrics.stage}
        activeProvider={routedVia ? `${activeProviderRaw} (${routedVia})` : activeProviderRaw}
        iteration={runMetrics.iteration}
        maxIterations={runMetrics.maxIterations}
      />
    </div>
  );
}