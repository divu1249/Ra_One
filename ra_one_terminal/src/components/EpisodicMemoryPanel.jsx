import React from 'react';
import { RefreshCw } from 'lucide-react';

export default function EpisodicMemoryPanel({ episodes, recalledNotes, onRefreshMemory }) {
  return (
    <section
      aria-label="Episodic Memory Inspector"
      data-testid="episodic-memory-panel"
      className="hud-chamfer hud-specular-top relative flex flex-col"
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-white/10">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0]">
            EPISODIC MEMORY LEDGER
          </h2>
          <span className="text-xs font-mono text-[#ff2a38] tabular-nums">
            {episodes.length} STORED
          </span>
        </div>
        <button
          type="button"
          onClick={onRefreshMemory}
          aria-label="Refresh episodic memory records"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono uppercase bg-black/50 hover:bg-[#ff1e2d]/15 text-[#e6eaf0] border border-white/15 hover:border-[#ff1e2d]/50 transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw size={12} className="text-[#ff1e2d]" />
          <span>SYNC MEMORY</span>
        </button>
      </div>

      {recalledNotes.length > 0 && (
        <div className="px-5 py-2.5 border-b border-white/10 bg-[#ff1e2d]/10">
          <div className="text-[11px] font-mono uppercase tracking-wider text-[#ff2a38] mb-1">
            RECALLED LESSONS INJECTED INTO ACTIVE RUN
          </div>
          <ul className="space-y-1 text-xs font-mono text-[#e6eaf0]">
            {recalledNotes.map((note, idx) => (
              <li key={idx} className="break-words">&gt; {note}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="max-h-[240px] overflow-y-auto divide-y divide-white/10 custom-scrollbar">
        {episodes.length === 0 ? (
          <div className="px-5 py-6 text-center text-xs text-[#7c8490]">
            No episodic lessons committed yet. Completed runs and resolved tracebacks are archived here automatically.
          </div>
        ) : (
          episodes.map((ep) => (
            <div key={ep.id} className="px-5 py-2.5 text-xs flex flex-col gap-1 hover:bg-white/[0.03] transition-colors">
              <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-[#7c8490] tabular-nums">#{ep.id}</span>
                  <span className="text-[#e6eaf0] font-medium uppercase">{ep.task_type}</span>
                  <span className="text-[#4a5160]" aria-hidden="true">/</span>
                  <span className="text-[#ff2a38]">{ep.error_signature}</span>
                </div>
                <span className="text-[#5e6573] tabular-nums">
                  {new Date(ep.timestamp * 1000).toLocaleTimeString([], { hour12: false })}
                </span>
              </div>
              <div className="text-[#c5ccd8] truncate">{ep.task_summary}</div>
              <div className="font-mono text-[11px] text-[#7c8490] truncate">
                STRATEGY: {ep.winning_strategy}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
