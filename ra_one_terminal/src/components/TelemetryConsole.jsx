import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

const EVENT_STYLES = {
  memory: { label: 'MEMORY', border: 'border-white/15', text: 'text-[#e6eaf0]', tag: 'text-sky-300' },
  actor: { label: 'ACTOR', border: 'border-[#ff1e2d]/35', text: 'text-[#e6eaf0]', tag: 'text-[#ff2a38]' },
  critic: { label: 'CRITIC', border: 'border-amber-500/40', text: 'text-amber-100', tag: 'text-amber-400' },
  error: { label: 'FAULT', border: 'border-[#ff1e2d]/60', text: 'text-red-200', tag: 'text-[#ff1e2d]' },
  final: { label: 'VERIFIED', border: 'border-[#ff1e2d]/50', text: 'text-white', tag: 'text-[#ff2a38]' },
  telemetry: { label: 'TELEMETRY', border: 'border-white/10', text: 'text-[#9aa2af]', tag: 'text-[#7c8490]' },
  user: { label: 'DIRECTIVE', border: 'border-white/25', text: 'text-white', tag: 'text-[#e6eaf0]' },
};

function renderDiffOrCodeLines(codeText) {
  const lines = codeText.split('\n');
  const isDiff = codeText.includes('--- a/') || codeText.includes('SIMULATING MUTATION');

  return lines.map((line, idx) => {
    let lineClass = 'text-[#d0d6e0]';
    if (isDiff) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        lineClass = 'text-emerald-300 bg-emerald-950/35';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        lineClass = 'text-red-300 bg-red-950/40';
      } else if (line.startsWith('@@') || line.startsWith('-- SIMULATING')) {
        lineClass = 'text-[#ff2a38] font-semibold';
      }
    }

    return (
      <div key={idx} className={`flex px-3 py-0.5 ${lineClass}`}>
        <span className="w-9 shrink-0 select-none text-[#58606d] text-right pr-3 tabular-nums">
          {idx + 1}
        </span>
        <span className="whitespace-pre-wrap break-all flex-1">{line || ' '}</span>
      </div>
    );
  });
}

export default function TelemetryConsole({ logs, codeArtifacts, activeCodeIndex, onSelectCodeIndex }) {
  const [filter, setFilter] = useState('all');
  const [copied, setCopied] = useState(false);
  const streamBoxRef = useRef(null);

  useEffect(() => {
    if (logs.length > 0 && streamBoxRef.current) {
      streamBoxRef.current.scrollTop = streamBoxRef.current.scrollHeight;
    }
  }, [logs.length]);

  const filteredLogs = logs.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'reasoning') return ['actor', 'critic', 'memory', 'final', 'error', 'user'].includes(entry.type);
    if (filter === 'telemetry') return entry.type === 'telemetry';
    return true;
  });

  const activeArtifact = codeArtifacts[activeCodeIndex] ?? null;

  const handleCopy = async () => {
    if (!activeArtifact?.content) return;
    try {
      await navigator.clipboard.writeText(activeArtifact.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard permission failure
    }
  };

  return (
    <section
      aria-label="Streaming Telemetry and Mutation Console"
      className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-[380px]"
    >
      {/* Left Pane: Live Thought / Traceback Stream */}
      <div className="hud-chamfer hud-specular-top relative flex flex-col min-h-[340px] max-h-[540px]">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-b border-white/10">
          <h2 className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0]">
            COGNITION STREAM
          </h2>
          <div className="flex items-center gap-1 bg-black/50 p-0.5 border border-white/10">
            {[
              { id: 'all', label: 'ALL' },
              { id: 'reasoning', label: 'ACTOR & CRITIC' },
              { id: 'telemetry', label: 'TELEMETRY' },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilter(tab.id)}
                className={`px-2.5 py-1 text-[11px] font-mono tracking-wider transition-colors whitespace-nowrap shrink-0 ${
                  filter === tab.id
                    ? 'bg-[#ff1e2d]/25 text-white border border-[#ff1e2d]/60'
                    : 'text-[#7c8490] hover:text-[#e6eaf0]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={streamBoxRef}
          className="flex-1 overflow-y-auto p-3.5 space-y-2 font-mono text-xs custom-scrollbar"
          data-testid="telemetry-stream"
        >
          {filteredLogs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-12 px-4 text-[#7c8490]">
              <p className="text-xs tracking-[0.2em] uppercase text-[#e6eaf0]">AWAITING DIRECTIVE</p>
              <p className="mt-1.5 text-xs text-[#7c8490]">
                Submit a directive or verification drill to stream Actor-Critic cognition and Hydra telemetry.
              </p>
            </div>
          ) : (
            filteredLogs.map((item, idx) => {
              const style = EVENT_STYLES[item.type] ?? EVENT_STYLES.telemetry;
              return (
                <div
                  key={idx}
                  className={`border ${style.border} bg-black/45 px-3 py-2`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className={`text-[11px] font-semibold tracking-wider ${style.tag}`}>
                      {style.label}
                    </span>
                    <span className="text-[11px] text-[#5e6573] tabular-nums">{item.time}</span>
                  </div>
                  <div className={`whitespace-pre-wrap break-words leading-relaxed ${style.text}`}>
                    {item.content}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Pane: Code Generation & Mutation Diff */}
      <div className="hud-chamfer hud-specular-top relative flex flex-col min-h-[340px] max-h-[540px]">
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-white/10">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0] whitespace-nowrap">
              CODE &amp; MUTATION DIFF
            </h2>
            {codeArtifacts.length > 0 && (
              <div className="flex items-center gap-1 overflow-x-auto">
                {codeArtifacts.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => onSelectCodeIndex(idx)}
                    className={`px-2 py-0.5 text-xs font-mono whitespace-nowrap shrink-0 border ${
                      idx === activeCodeIndex
                        ? 'bg-[#ff1e2d]/25 text-white border-[#ff1e2d]/60'
                        : 'bg-black/40 text-[#7c8490] border-white/10 hover:text-[#e6eaf0]'
                    }`}
                  >
                    #{idx + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!activeArtifact}
            aria-label="Copy active code or mutation diff"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono uppercase bg-black/50 hover:bg-[#ff1e2d]/15 text-[#e6eaf0] border border-white/15 hover:border-[#ff1e2d]/50 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            {copied ? <Check size={13} className="text-[#ff2a38]" /> : <Copy size={13} />}
            <span>{copied ? 'COPIED' : 'COPY'}</span>
          </button>
        </div>

        <div
          className="flex-1 overflow-y-auto py-3 font-mono text-xs leading-relaxed custom-scrollbar"
          data-testid="code-diff-pane"
        >
          {activeArtifact ? (
            renderDiffOrCodeLines(activeArtifact.content)
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center py-12 px-4 text-[#7c8490]">
              <p className="text-xs tracking-[0.2em] uppercase text-[#e6eaf0]">NO KERNEL STAGED</p>
              <p className="mt-1.5 text-xs text-[#7c8490]">
                Generated Python kernels and unified shadow diffs appear here for Critic inspection.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
