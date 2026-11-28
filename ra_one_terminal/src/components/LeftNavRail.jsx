import React from 'react';

const NAV_ITEMS = [
  { id: 'monitor', label: 'NN MONITOR' },
  { id: 'telemetry', label: 'TELEMETRY' },
  { id: 'diagnostics', label: 'DIAGNOSTICS' },
  { id: 'logs', label: 'LOGS' },
  { id: 'settings', label: 'SETTINGS' },
  { id: 'security', label: 'SECURITY' },
];

export default function LeftNavRail({ activeTab, onSelectTab, logsCount = 0, codeCount = 0 }) {
  return (
    <>
      {/* Desktop Vertical Rail */}
      <aside
        aria-label="Primary HUD Navigation"
        className="hidden lg:flex flex-col w-[176px] shrink-0 hud-chamfer hud-specular-top relative py-6 select-none"
      >
        <nav className="flex flex-col gap-1.5 mt-4">
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            const badge =
              item.id === 'logs' && (logsCount > 0 || codeCount > 0)
                ? codeCount > 0
                  ? `${codeCount}`
                  : `${logsCount}`
                : null;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`group relative flex items-center justify-between px-4 py-3 text-left transition-all duration-150 ${
                  isActive
                    ? 'bg-gradient-to-r from-[#ff1e2d]/22 via-[#ff1e2d]/08 to-transparent text-[#ff2a38]'
                    : 'text-[#7c8490] hover:text-[#e6eaf0] hover:bg-white/[0.03]'
                }`}
              >
                {isActive && (
                  <span
                    className="absolute left-0 top-1 bottom-1 w-[3px] bg-[#ff1e2d] shadow-[0_0_12px_#ff1e2d,0_0_24px_rgba(255,30,45,0.85)]"
                    aria-hidden="true"
                  />
                )}
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`font-mono text-xs transition-transform ${
                      isActive
                        ? 'text-[#ff1e2d] opacity-100 translate-x-0'
                        : 'text-[#ff1e2d] opacity-0 -translate-x-1 group-hover:opacity-60 group-hover:translate-x-0'
                    }`}
                    aria-hidden="true"
                  >
                    &gt;
                  </span>
                  <span
                    className={`text-xs font-semibold tracking-[0.2em] uppercase whitespace-nowrap ${
                      isActive ? 'crimson-glow-text' : ''
                    }`}
                  >
                    {item.label}
                  </span>
                </span>
                {badge && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 bg-[#ff1e2d]/15 border border-[#ff1e2d]/40 text-[#ff8b94] tabular-nums">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto px-4 pt-6 border-t border-white/10 text-[10px] font-mono tracking-[0.18em] text-[#5c6370] uppercase">
          <div>LINK // HART-V2</div>
          <div className="mt-1 text-[#ff1e2d]/70">NODE_01 ONLINE</div>
        </div>
      </aside>

      {/* Mobile / Tablet Compact Horizontal Rail */}
      <nav
        aria-label="Mobile HUD Navigation"
        className="flex lg:hidden items-center gap-1.5 overflow-x-auto pb-1 custom-scrollbar"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`px-3 py-2 text-[11px] font-semibold tracking-[0.16em] uppercase whitespace-nowrap shrink-0 border transition-colors ${
                isActive
                  ? 'bg-[#ff1e2d]/20 border-[#ff1e2d]/70 text-[#ff2a38] shadow-[0_0_12px_rgba(255,30,45,0.3)]'
                  : 'bg-[#090a0e]/80 border-white/10 text-[#7c8490] hover:text-[#e6eaf0]'
              }`}
            >
              {isActive ? `> ${item.label}` : item.label}
            </button>
          );
        })}
      </nav>
    </>
  );
}
