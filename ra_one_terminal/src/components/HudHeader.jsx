import React from 'react';

export default function HudHeader() {
  return (
    <header className="relative z-20 px-4 pt-2 pb-2 lg:px-6 border-b border-[#ff1e2d]/25 bg-[#040407]/80 backdrop-blur-md shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Metallic RA◆ONE Brand */}
        <div className="flex flex-col leading-none select-none">
          <div className="flex items-center gap-1.5">
            <h1
              className="text-2xl lg:text-[28px] font-black tracking-[0.12em] uppercase raone-metal-logo"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              RA
            </h1>
            <span
              className="inline-block w-2 h-2 rotate-45 bg-[#ff1e2d] shadow-[0_0_10px_#ff1e2d,0_0_20px_rgba(255,30,45,0.8)]"
              aria-hidden="true"
            />
            <span
              className="text-2xl lg:text-[28px] font-black tracking-[0.12em] uppercase raone-metal-logo"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              ONE
            </span>
          </div>
          <span
            className="mt-1 text-[10px] lg:text-[11px] font-semibold tracking-[0.34em] uppercase text-[#8b93a0]"
            style={{ fontFamily: 'var(--font-hud)' }}
          >
            NEURAL INTELLIGENCE DIVISION
          </span>
        </div>

        {/* Right: Telemetric Terminal Title & /// Slashes */}
        <div className="flex items-center gap-3 ml-auto">
          <span
            className="text-[11px] lg:text-xs font-medium tracking-[0.26em] uppercase text-[#7c8490]"
            style={{ fontFamily: 'var(--font-hud)' }}
          >
            TELEMETRIC NEURAL NETWORK TERMINAL
          </span>
          <div className="flex items-center gap-1 select-none" aria-hidden="true">
            <span className="inline-block w-[3px] h-4 bg-[#ff1e2d] -skew-x-[24deg] shadow-[0_0_10px_#ff1e2d]" />
            <span className="inline-block w-[3px] h-4 bg-[#ff1e2d] -skew-x-[24deg] shadow-[0_0_10px_#ff1e2d]" />
            <span className="inline-block w-[3px] h-4 bg-[#ff1e2d] -skew-x-[24deg] shadow-[0_0_10px_#ff1e2d]" />
          </div>
        </div>
      </div>

      {/* Specular crimson horizontal hairline glow */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-white/50 via-[#ff1e2d]/60 to-white/40"
        aria-hidden="true"
      />
    </header>
  );
}
