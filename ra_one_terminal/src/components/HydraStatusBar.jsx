import React from 'react';
import { RefreshCw, UploadCloud } from 'lucide-react';

export default function HydraStatusBar({
  health,
  healthLoading,
  runMetrics,
  onRefreshHealth,
  onFlushQueue,
  flushingQueue,
}) {
  const providers = health?.providers ?? [];
  const tierLabel = (health?.active_tier ?? 'TIER_0').replace('_', ' ');
  const activeProvider = runMetrics.activeProvider || health?.active_provider || 'standby';
  const routedVia =
    runMetrics.routedVia ||
    (activeProvider === 'freellmapi' ? health?.last_routed_via : null);
  const queueDepth = health?.offline_queue_depth ?? 0;

  const statusTone =
    health?.status === 'online'
      ? 'text-[#ff2a38] crimson-glow-text'
      : health?.status === 'degraded'
      ? 'text-amber-400'
      : 'text-red-500';

  return (
    <section
      aria-label="Hydra Router Pool Telemetry"
      className="hud-chamfer hud-specular-top relative px-5 py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4 min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                health?.status === 'online'
                  ? 'bg-[#ff1e2d] shadow-[0_0_12px_#ff1e2d]'
                  : 'bg-amber-400 shadow-[0_0_10px_#f59e0b]'
              }`}
              aria-hidden="true"
            />
            <span className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0]">
              HYDRA ROUTER POOL
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums">
            <span className={`font-semibold uppercase ${statusTone}`} data-testid="health-status">
              {health ? health.status : 'connecting'}
            </span>
            <span className="text-[#4a5160]" aria-hidden="true">/</span>
            <span className="text-[#e6eaf0]" data-testid="active-tier">
              {tierLabel}
            </span>
            <span className="text-[#4a5160]" aria-hidden="true">/</span>
            <span className="text-[#7c8490]" data-testid="active-provider-badge">
              ACTIVE: <strong className="text-[#e6eaf0] uppercase">{activeProvider}</strong>
              {routedVia && (
                <span className="ml-1.5 text-[#ff2a38]" data-testid="routed-via-badge">
                  [{routedVia}]
                </span>
              )}
            </span>
            {runMetrics.lastLatencyMs !== null && (
              <>
                <span className="text-[#4a5160]" aria-hidden="true">/</span>
                <span className="text-[#e6eaf0]">{runMetrics.lastLatencyMs}ms</span>
              </>
            )}
            {runMetrics.failoverCount > 0 && (
              <>
                <span className="text-[#4a5160]" aria-hidden="true">/</span>
                <span className="text-amber-400">FAILOVERS: {runMetrics.failoverCount}</span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {queueDepth > 0 && (
            <button
              type="button"
              onClick={onFlushQueue}
              disabled={flushingQueue}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono uppercase tracking-wider bg-amber-950/50 hover:bg-amber-900/60 text-amber-200 border border-amber-500/40 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <UploadCloud size={14} />
              <span>{flushingQueue ? 'FLUSHING...' : `FLUSH QUEUE (${queueDepth})`}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onRefreshHealth}
            disabled={healthLoading}
            aria-label="Refresh Hydra health diagnostics"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono uppercase tracking-wider bg-[#101219]/90 hover:bg-[#ff1e2d]/15 text-[#e6eaf0] border border-white/15 hover:border-[#ff1e2d]/50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            <RefreshCw size={13} className={healthLoading ? 'animate-spin text-[#ff1e2d]' : 'text-[#ff1e2d]'} />
            <span>REFRESH HEALTH</span>
          </button>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-white/10 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs font-mono tabular-nums">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {providers.map((p) => {
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
            const color = isFree && freeState
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
              <div key={p.name} className="flex items-center gap-2 bg-black/30 px-2.5 py-1 border border-white/10">
                <span className="text-[#7c8490] uppercase">{p.name}</span>
                <span className={`font-semibold ${color}`}>{label}</span>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center md:justify-end gap-x-5 gap-y-1 text-[#7c8490]">
          <span>
            MEMORY:{' '}
            <span className="text-[#e6eaf0] uppercase">
              {health?.episodic_memory?.backend ?? 'initializing'}
            </span>{' '}
            ({health?.episodic_memory?.episode_count ?? 0})
          </span>
          <span>
            SANDBOX:{' '}
            <span className="text-[#e6eaf0] uppercase">
              {health?.sandbox?.ready ? 'ISOLATED PYTHON3' : 'OFFLINE'}
            </span>
          </span>
          <span>
            QUEUE: <span className="text-[#e6eaf0]">{queueDepth}</span>
          </span>
          {health?.uptime_seconds !== undefined && (
            <span>
              UPTIME: <span className="text-[#e6eaf0]">{health.uptime_seconds}s</span>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
