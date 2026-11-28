import React from 'react';

const STAGE_LAYER_TEXT = {
  idle: 'DECISION LAYER ACTIVE...',
  memory: 'EPISODIC MEMORY RECALL LAYER ACTIVE...',
  actor: 'ACTOR SYNTHESIS LAYER ACTIVE...',
  sandbox: 'SANDBOX EXECUTION LAYER ACTIVE...',
  mutate: 'MUTATION DIFF LAYER ACTIVE...',
  critic: 'ADVERSARIAL CRITIC LAYER ACTIVE...',
  verified: 'DECISION LAYER ACTIVE...',
  error: 'FAULT ISOLATION LAYER ACTIVE...',
};

export default function HudFooter({ stage = 'idle', activeProvider = null, iteration = 0, maxIterations = 5 }) {
  const layerLabel = STAGE_LAYER_TEXT[stage] || STAGE_LAYER_TEXT.idle;
  const providerTag = (activeProvider || 'HYDRA-CORE').toUpperCase();

  return (
    <footer className="relative z-20 px-4 py-2 lg:px-6 border-t border-[#ff1e2d]/25 bg-[#040407]/85 backdrop-blur-md">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-[#ff1e2d]/50 via-white/35 to-[#ff1e2d]/50"
        aria-hidden="true"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono tracking-[0.2em] uppercase">
        <div className="text-[#a53139] font-medium" data-testid="footer-layer-status">
          {layerLabel}
        </div>

        <div className="hidden sm:flex items-center gap-4 text-[#5e6573] tabular-nums">
          <span>0x7F4A // {providerTag}</span>
          <span>LOOP {iteration}/{maxIterations}</span>
        </div>

        <div className="flex items-center gap-1 select-none" aria-hidden="true">
          <span className="inline-block w-[3px] h-3.5 bg-[#ff1e2d] -skew-x-[24deg] shadow-[0_0_8px_#ff1e2d]" />
          <span className="inline-block w-[3px] h-3.5 bg-[#ff1e2d] -skew-x-[24deg] shadow-[0_0_8px_#ff1e2d]" />
          <span className="inline-block w-[3px] h-3.5 bg-[#ff1e2d] -skew-x-[24deg] shadow-[0_0_8px_#ff1e2d]" />
        </div>
      </div>
    </footer>
  );
}
