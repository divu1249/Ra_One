import React, { useEffect, useRef } from 'react';

export default function SecondaryMonitorCanvas({ stage = 'idle', isRunning = false }) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ stage, isRunning });

  useEffect(() => {
    stateRef.current = { stage, isRunning };
  }, [stage, isRunning]);

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
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(80, Math.floor(rect.height));
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
      if (now - lastFrame < 50) return;
      lastFrame = now;
      const t = (now - startTime) * 0.001;
      const { stage: curStage, isRunning: running } = stateRef.current;
      const w = canvas.width;
      const h = canvas.height;
      const cx = w * 0.56;
      const cy = h * 0.54;
      const s = Math.min(w, h) * 0.44;

      ctx.clearRect(0, 0, w, h);

      // Subtle crimson grid backdrop
      ctx.strokeStyle = 'rgba(255, 30, 45, 0.12)';
      ctx.lineWidth = 1;
      const step = Math.max(14, Math.round(s * 0.35));
      ctx.beginPath();
      for (let x = 0; x < w; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
      }
      for (let y = 0; y < h; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Angled 32-deg profile wireframe/voxel hood silhouette
      const bob = Math.sin(t * (running ? 4 : 1.5)) * 1.5;
      const points = [
        [-0.55, -0.78],
        [-0.08, -0.88],
        [0.44, -0.46],
        [0.62, 0.22],
        [0.42, 0.85],
        [-0.22, 0.85],
        [-0.48, 0.34],
        [-0.36, -0.18],
      ];

      ctx.save();
      ctx.translate(cx, cy + bob);

      // Crimson underglow
      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, s * 1.1);
      glow.addColorStop(0, 'rgba(255, 30, 45, 0.28)');
      glow.addColorStop(1, 'rgba(255, 30, 45, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-w, -h, w * 2, h * 2);

      // Dark voxel mosaic inside angled profile
      for (let row = -5; row <= 5; row++) {
        for (let col = -4; col <= 4; col++) {
          const bx = col * s * 0.16;
          const by = row * s * 0.15;
          const dist = Math.hypot(bx * 0.9, by * 0.72);
          if (dist > s * 0.86) continue;
          const isCrack = (row >= 0 && row <= 3 && col >= -2 && col <= 1) && ((row + col) % 2 === 0);
          ctx.fillStyle = isCrack
            ? `rgba(255, 30, 45, ${0.42 + 0.38 * Math.sin(t * 4 + row)})`
            : 'rgba(26, 28, 36, 0.85)';
          ctx.fillRect(bx, by, s * 0.13, s * 0.12);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.lineWidth = 0.7;
          ctx.strokeRect(bx, by, s * 0.13, s * 0.12);
        }
      }

      // Wireframe contour
      ctx.strokeStyle = curStage === 'critic' ? 'rgba(255, 110, 80, 0.8)' : 'rgba(255, 30, 45, 0.72)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      points.forEach(([px, py], idx) => {
        if (idx === 0) ctx.moveTo(px * s, py * s);
        else ctx.lineTo(px * s, py * s);
      });
      ctx.closePath();
      ctx.stroke();

      // Profile eye slit
      ctx.fillStyle = '#ff1e2d';
      ctx.beginPath();
      ctx.moveTo(-s * 0.22, -s * 0.18);
      ctx.lineTo(s * 0.04, -s * 0.11);
      ctx.lineTo(-s * 0.14, -s * 0.08);
      ctx.closePath();
      ctx.fill();

      ctx.restore();

      // Micro telemetry tag inside mini monitor
      ctx.fillStyle = 'rgba(180, 190, 205, 0.65)';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText('0x32° PROFILE', 8, 15);
      ctx.fillStyle = 'rgba(255, 42, 56, 0.8)';
      ctx.fillText(curStage.toUpperCase(), 8, h - 8);
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Secondary Angled Core Telemetry Monitor"
      className="w-full h-full block"
    />
  );
}
