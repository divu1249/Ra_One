import React, { useEffect, useRef } from 'react';

export default function WaveformCanvas({
  variant = 'eeg',
  spikeLevel = 0.35,
  pulseAt = 0,
  phaseOffset = 0,
  isRunning = false,
}) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ variant, spikeLevel, pulseAt, phaseOffset, isRunning });

  useEffect(() => {
    stateRef.current = { variant, spikeLevel, pulseAt, phaseOffset, isRunning };
  }, [variant, spikeLevel, pulseAt, phaseOffset, isRunning]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let rafId = 0;
    const startTime = performance.now();
    let lastFrame = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(80, Math.floor(rect.width));
      const h = Math.max(20, Math.floor(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now) => {
      rafId = requestAnimationFrame(draw);
      if (now - lastFrame < 45) return;
      lastFrame = now;

      const t = (now - startTime) * 0.001;
      const { variant: mode, spikeLevel: baseLevel, pulseAt: lastPulse, phaseOffset: pOff, isRunning: running } =
        stateRef.current;
      const w = canvas.width;
      const h = canvas.height;
      const midY = h * 0.5;

      ctx.clearRect(0, 0, w, h);

      // Subtle baseline axis
      ctx.strokeStyle = 'rgba(255, 30, 45, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.stroke();

      const pulseAge = lastPulse > 0 ? Math.max(0, (Date.now() - lastPulse) / 1000) : 99;
      const pulseBoost = pulseAge < 1.8 ? Math.exp(-pulseAge * 1.9) * 0.65 : 0;
      const ampScale = Math.min(1.0, baseLevel + pulseBoost + (running ? 0.18 : 0));

      if (mode === 'eeg') {
        const samples = 96;
        const pts = new Array(samples + 1);
        for (let i = 0; i <= samples; i++) {
          const nx = i / samples;
          const x = nx * w;
          const envelope = Math.sin(nx * Math.PI);
          const wave1 = Math.sin(nx * 46 - t * (running ? 8.5 : 3.6) + pOff);
          const wave2 = Math.cos(nx * 92 + t * 6.2) * 0.62;
          const spike = Math.pow(Math.abs(Math.sin(nx * 22 - t * 2.8)), 5) * 1.75 * (wave1 >= 0 ? 1 : -1);
          const y =
            midY +
            (wave1 * 0.34 + wave2 * 0.3 + spike * 0.52) *
              (h * 0.45) *
              ampScale *
              (0.28 + envelope * 0.72);
          pts[i] = [x, y];
        }

        // Fast multi-pass glow instead of expensive shadowBlur
        ctx.strokeStyle = 'rgba(255, 30, 45, 0.28)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();

        ctx.strokeStyle = '#ff2434';
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // Crisp secondary echo trace
        ctx.strokeStyle = 'rgba(255, 160, 170, 0.3)';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
          const nx = i / samples;
          const x = nx * w;
          const y = midY + Math.sin(nx * 32 - t * 4.4 + 1.2) * (h * 0.16) * ampScale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else {
        const samples = 48;
        const speed = running ? 5.8 : 2.3;
        const pts = new Array(samples + 1);
        for (let i = 0; i <= samples; i++) {
          const nx = i / samples;
          const x = nx * w;
          const taper = Math.sin(nx * Math.PI);
          const y =
            midY +
            Math.sin(nx * 18 - t * speed + pOff) *
              (h * 0.34) *
              Math.min(1, 0.32 + ampScale * 0.68) *
              (0.35 + taper * 0.65);
          pts[i] = [x, y];
        }

        ctx.strokeStyle = 'rgba(255, 30, 45, 0.24)';
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
        ctx.stroke();

        ctx.strokeStyle = pulseBoost > 0.1 ? '#ff4655' : '#e11d2e';
        ctx.lineWidth = 1.3;
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 30, 45, 0.26)';
        ctx.lineWidth = 0.85;
        ctx.beginPath();
        for (let i = 0; i <= samples; i++) {
          const nx = i / samples;
          const x = nx * w;
          const y = midY + Math.cos(nx * 14 - t * (speed * 0.7) + pOff) * (h * 0.18);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="w-full h-full block" />;
}
