import React, { useEffect, useRef } from 'react';

function createSeededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function buildVoxelCloud() {
  const rand = createSeededRandom(204919);
  const blocks = [];

  // 1. Grid-structured fractured voxel hood silhouette
  for (let row = -15; row <= 14; row++) {
    const ny = row / 15;
    const halfWidth =
      ny < -0.55
        ? 0.28 + (ny + 1) * 0.85
        : ny < 0.35
        ? 0.66 + (ny + 0.55) * 0.25
        : 0.88 + (ny - 0.35) * 0.32;

    for (let col = -13; col <= 13; col++) {
      const nx = col / 13;
      const absX = Math.abs(nx);
      const faceDist =
        (nx * nx) / (0.36 * 0.36) + ((ny + 0.04) * (ny + 0.04)) / (0.52 * 0.52);

      if (absX <= halfWidth && faceDist > 0.86) {
        const edgeFade = 1 - Math.max(0, (absX - (halfWidth - 0.16)) / 0.18);
        if (rand() > edgeFade * 0.92) continue;

        blocks.push({
          x: nx * 175,
          y: ny * 210,
          z: (1 - absX) * 45 + (rand() - 0.5) * 18,
          w: 11 + rand() * 14,
          h: 11 + rand() * 14,
          region: 'hood',
          phase: rand() * Math.PI * 2,
          speed: 0.5 + rand() * 1.1,
          shade: 16 + rand() * 24,
        });
      }
    }
  }

  // 2. Dense churning inner faceless mask blocks
  for (let i = 0; i < 420; i++) {
    const angle = rand() * Math.PI * 2;
    const rad = Math.sqrt(rand());
    const nx = Math.cos(angle) * rad * 0.35;
    const ny = Math.sin(angle) * rad * 0.5 - 0.03;

    if (ny > 0.15 && Math.abs(nx) > 0.34 - (ny - 0.15) * 0.48) continue;

    // Carve recessed eye slits so crimson eyes pierce cleanly
    const leftEye =
      ((nx + 0.145) * (nx + 0.145)) / (0.068 * 0.068) +
      ((ny + 0.145) * (ny + 0.145)) / (0.032 * 0.032);
    const rightEye =
      ((nx - 0.145) * (nx - 0.145)) / (0.068 * 0.068) +
      ((ny + 0.145) * (ny + 0.145)) / (0.032 * 0.032);
    if (leftEye < 1 || rightEye < 1) continue;

    blocks.push({
      x: nx * 175,
      y: ny * 210,
      z: 55 + (1 - rad) * 38 + (rand() - 0.5) * 20,
      w: 6 + rand() * 11,
      h: 6 + rand() * 11,
      region: 'face',
      phase: rand() * Math.PI * 2,
      speed: 1.4 + rand() * 2.4,
      shade: 12 + rand() * 22,
    });
  }

  // 3. Outer drifting memory fragments
  for (let i = 0; i < 55; i++) {
    const a = rand() * Math.PI * 2;
    const r = 165 + rand() * 85;
    blocks.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r * 1.08,
      z: (rand() - 0.5) * 70,
      w: 4 + rand() * 8,
      h: 4 + rand() * 8,
      region: 'debris',
      phase: rand() * Math.PI * 2,
      speed: 0.8 + rand() * 1.4,
      shade: 20 + rand() * 30,
    });
  }

  return blocks;
}

const VOXEL_BLOCKS = buildVoxelCloud();

export default function NeuralCoreCanvas({
  stage = 'idle',
  isRunning = false,
  parallaxEnabled = true,
}) {
  const canvasRef = useRef(null);
  const stateRef = useRef({ stage, isRunning, parallaxEnabled });
  const pointerRef = useRef({ targetX: 0, targetY: 0, x: 0, y: 0 });

  useEffect(() => {
    stateRef.current = { stage, isRunning, parallaxEnabled };
  }, [stage, isRunning, parallaxEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;

    let rafId = 0;
    let lastFrame = 0;
    let t = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(240, Math.floor(rect.width));
      const h = Math.max(240, Math.floor(rect.height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const render = (now) => {
      rafId = requestAnimationFrame(render);
      if (now - lastFrame < 42) return;
      lastFrame = now;

      const { stage: curStage, isRunning: running, parallaxEnabled: allowParallax } = stateRef.current;
      const ptr = pointerRef.current;
      const tx = allowParallax ? ptr.targetX : 0;
      const ty = allowParallax ? ptr.targetY : 0;
      ptr.x += (tx - ptr.x) * 0.1;
      ptr.y += (ty - ptr.y) * 0.1;

      const W = canvas.width;
      const H = canvas.height;
      const cx = W * 0.5;
      const cy = H * 0.51;
      const scaleFit = Math.min(W / 430, H / 460);

      const intensity =
        curStage === 'error' || curStage === 'critic'
          ? 2.1
          : curStage === 'actor' || curStage === 'mutate'
          ? 1.65
          : curStage === 'sandbox' || curStage === 'memory'
          ? 1.35
          : curStage === 'verified'
          ? 1.15
          : 0.7;

      t += 0.032 * intensity;
      ctx.clearRect(0, 0, W, H);

      // Deep crimson core aura behind head
      const aura = ctx.createRadialGradient(cx, cy, 10, cx, cy, 240 * scaleFit);
      aura.addColorStop(0, 'rgba(255, 22, 38, 0.34)');
      aura.addColorStop(0.45, 'rgba(145, 8, 22, 0.16)');
      aura.addColorStop(1, 'rgba(4, 4, 7, 0)');
      ctx.fillStyle = aura;
      ctx.fillRect(0, 0, W, H);

      // Fine red HUD coordinate grid
      ctx.strokeStyle = 'rgba(255, 30, 45, 0.1)';
      ctx.lineWidth = 0.8;
      const gridStep = Math.max(20, 28 * scaleFit);
      ctx.beginPath();
      for (let gx = cx % gridStep; gx < W; gx += gridStep) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, H);
      }
      for (let gy = cy % gridStep; gy < H; gy += gridStep) {
        ctx.moveTo(0, gy);
        ctx.lineTo(W, gy);
      }
      ctx.stroke();

      // Central crosshair axes
      ctx.strokeStyle = 'rgba(255, 40, 56, 0.24)';
      ctx.beginPath();
      ctx.moveTo(0, cy - 33 * scaleFit);
      ctx.lineTo(W, cy - 33 * scaleFit);
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, H);
      ctx.stroke();

      // Concentric glowing crimson target rings
      const rings = [132, 168, 206];
      rings.forEach((r, idx) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(t * (idx % 2 === 0 ? 0.08 : -0.06));
        ctx.strokeStyle = idx === 1 ? 'rgba(255, 34, 48, 0.38)' : 'rgba(255, 34, 48, 0.18)';
        ctx.lineWidth = idx === 1 ? 1.2 : 0.85;
        ctx.setLineDash(idx === 2 ? [18, 10, 4, 10] : []);
        ctx.beginPath();
        ctx.arc(0, 0, r * scaleFit, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      });
      ctx.setLineDash([]);

      // Subtle parallax rotation from cursor
      const rotY = ptr.x * 0.16 + Math.sin(t * 0.35) * 0.03;
      const rotX = -ptr.y * 0.11 + Math.cos(t * 0.25) * 0.02;
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      // Migrating internal crimson energy hotspots (cheek & jaw fissures)
      const hot1 = {
        x: -24 + Math.sin(t * 1.1) * 14,
        y: 12 + Math.cos(t * 0.9) * 16,
      };
      const hot2 = {
        x: 20 + Math.cos(t * 1.3) * 16,
        y: 44 + Math.sin(t * 1.0) * 18,
      };

      // Internal glowing magma backing behind face cavity
      const cavityGrad = ctx.createRadialGradient(
        cx + hot1.x * scaleFit,
        cy + hot1.y * scaleFit,
        4,
        cx,
        cy + 10 * scaleFit,
        92 * scaleFit
      );
      cavityGrad.addColorStop(0, `rgba(255, 38, 52, ${0.72 * Math.min(1.2, intensity)})`);
      cavityGrad.addColorStop(0.55, 'rgba(190, 12, 26, 0.45)');
      cavityGrad.addColorStop(1, 'rgba(10, 2, 4, 0)');
      ctx.fillStyle = cavityGrad;
      ctx.beginPath();
      ctx.ellipse(cx, cy - 2 * scaleFit, 62 * scaleFit, 92 * scaleFit, 0, 0, Math.PI * 2);
      ctx.fill();

      const isFault = curStage === 'error' || curStage === 'critic';
      const projected = VOXEL_BLOCKS.map((b, idx) => {
        const churnAmp =
          b.region === 'face'
            ? (isFault ? 24 : 11) * intensity
            : b.region === 'debris'
            ? 14
            : 3.5;

        const dz = Math.sin(t * b.speed + b.phase) * churnAmp;
        const dy = b.region === 'face' ? Math.cos(t * b.speed * 0.8 + b.phase) * 2.2 * intensity : 0;
        const jitterX = isFault && b.region === 'face' ? Math.sin(t * 23 + idx) * 6 : 0;

        const x0 = b.x + jitterX;
        const y0 = b.y + dy;
        const z0 = b.z + dz;

        const x1 = x0 * cosY - z0 * sinY;
        const z1 = z0 * cosY + x0 * sinY;
        const y2 = y0 * cosX - z1 * sinX;
        const z2 = z1 * cosX + y0 * sinX;

        const persp = 520 / (520 - z2);
        const sx = cx + x1 * persp * scaleFit;
        const sy = cy + y2 * persp * scaleFit;
        const sw = b.w * persp * scaleFit;
        const sh = b.h * persp * scaleFit;

        const dHot1 = Math.hypot(b.x - hot1.x, b.y - hot1.y);
        const dHot2 = Math.hypot(b.x - hot2.x, b.y - hot2.y);
        const heat =
          Math.max(Math.exp(-(dHot1 * dHot1) / 1400), Math.exp(-(dHot2 * dHot2) / 1600)) *
          (b.region === 'face' ? 1 : 0.35);

        return { b, sx, sy, sw, sh, z2, dz, heat };
      });

      projected.sort((a, b) => a.z2 - b.z2);

      for (let i = 0; i < projected.length; i++) {
        const { b, sx, sy, sw, sh, dz, heat } = projected[i];
        const x = sx - sw * 0.5;
        const y = sy - sh * 0.5;

        if (heat > 0.28 || (b.region === 'face' && dz > 6)) {
          const glowAlpha = Math.min(0.85, heat * 0.85 + Math.max(0, dz / 35));
          ctx.fillStyle = `rgba(255, 24, 42, ${glowAlpha * 0.55})`;
          ctx.fillRect(x - 1.5, y - 1.5, sw + 3, sh + 3);
        }

        const base = b.shade + Math.max(0, dz * 0.45);
        const rCol = Math.min(255, base + heat * 95);
        const gCol = Math.min(255, base + heat * 12);
        const bCol = Math.min(255, base + 4 + heat * 14);

        ctx.fillStyle = `rgba(${rCol | 0}, ${gCol | 0}, ${bCol | 0}, ${b.region === 'debris' ? 0.58 : 0.92})`;
        ctx.fillRect(x, y, sw, sh);

        ctx.strokeStyle =
          heat > 0.42 ? `rgba(255, 58, 72, ${0.45 + heat * 0.4})` : 'rgba(180, 195, 215, 0.17)';
        ctx.lineWidth = 0.75;
        ctx.strokeRect(x, y, sw, sh);
      }

      // Piercing slanted crimson eyes
      const drawEye = (side) => {
        const ex = cx + (side * 27 + ptr.x * 8) * scaleFit;
        const ey = cy + (-33 + ptr.y * 5) * scaleFit;
        const eyeGlow = ctx.createRadialGradient(ex, ey, 1, ex, ey, 28 * scaleFit);
        eyeGlow.addColorStop(0, 'rgba(255, 245, 245, 0.98)');
        eyeGlow.addColorStop(0.22, 'rgba(255, 28, 44, 0.95)');
        eyeGlow.addColorStop(0.55, 'rgba(220, 10, 26, 0.42)');
        eyeGlow.addColorStop(1, 'rgba(220, 10, 26, 0)');

        ctx.fillStyle = eyeGlow;
        ctx.beginPath();
        ctx.arc(ex, ey, 28 * scaleFit, 0, Math.PI * 2);
        ctx.fill();

        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(side * -0.18);
        ctx.fillStyle = '#fff1f2';
        ctx.beginPath();
        ctx.ellipse(0, 0, 9.5 * scaleFit, 2.7 * scaleFit, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };

      drawEye(-1);
      drawEye(1);

      // Horizontal HUD scanner flare during active execution
      if (running || curStage === 'sandbox' || curStage === 'actor') {
        const scanY = (t * 58) % H;
        const scanGrad = ctx.createLinearGradient(0, scanY - 18, 0, scanY + 18);
        scanGrad.addColorStop(0, 'rgba(255, 30, 45, 0)');
        scanGrad.addColorStop(0.5, 'rgba(255, 42, 58, 0.28)');
        scanGrad.addColorStop(1, 'rgba(255, 30, 45, 0)');
        ctx.fillStyle = scanGrad;
        ctx.fillRect(0, scanY - 18, W, 36);
      }
    };

    rafId = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const handlePointerMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2;
    const ny = ((e.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2;
    pointerRef.current.targetX = Math.max(-1, Math.min(1, nx));
    pointerRef.current.targetY = Math.max(-1, Math.min(1, ny));
  };

  const handlePointerLeave = () => {
    pointerRef.current.targetX = 0;
    pointerRef.current.targetY = 0;
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      aria-label="Procedural 3D Voxel Neural Core"
      className="w-full h-full block cursor-crosshair"
    />
  );
}
