export const INITIAL_RUN_METRICS = {
  stage: 'idle',
  iteration: 0,
  maxIterations: 5,
  activeProvider: null,
  routedVia: null,
  upstreamRetries: null,
  failoverCount: 0,
  lastLatencyMs: null,
  recalledNotes: [],
};

/**
 * Maps an SSE event to one of the 4 HUD Neural Flow channels:
 * 'cortex' | 'memory' | 'emotion' | 'decision'
 */
export function getNeuralChannelForEvent(event) {
  const type = String(event?.type ?? 'telemetry');
  const content = String(event?.content ?? '');

  if (type === 'memory') return 'memory';
  if (type === 'actor' || type === 'code') return 'cortex';
  if (type === 'critic' || type === 'error') return 'emotion';
  if (type === 'final') return 'decision';
  if (content.includes('[SANDBOX]') || content.includes('[HYDRA]') || content.includes('SIMULATING MUTATION')) {
    return 'decision';
  }
  return 'cortex';
}

/**
 * Pure reducer mapping a single SSE event ({ type, content }) to next run metrics.
 */
export function reduceSseEvent(metrics, event) {
  const next = { ...metrics };
  const content = String(event?.content ?? '');
  const type = String(event?.type ?? 'telemetry');

  if (type === 'memory') {
    next.stage = 'memory';
    if (content.includes('[MEMORY HIT]')) {
      next.recalledNotes = [...next.recalledNotes, content];
    }
    if (content.includes('[MEMORY WRITE]')) {
      next.stage = 'verified';
    }
  } else if (type === 'actor') {
    next.stage = 'actor';
    const iterMatch = content.match(/Iteration\s+(\d+)\/(\d+)/i);
    if (iterMatch) {
      next.iteration = Number(iterMatch[1]);
      next.maxIterations = Number(iterMatch[2]);
    }
  } else if (type === 'code') {
    next.stage = content.includes('SIMULATING MUTATION') ? 'mutate' : 'sandbox';
  } else if (type === 'critic') {
    next.stage = content.includes('CRITIC APPROVED') ? 'verified' : 'critic';
  } else if (type === 'final') {
    next.stage = 'verified';
  } else if (type === 'error') {
    next.stage = 'error';
  } else if (type === 'telemetry') {
    if (content.includes('[SANDBOX]')) {
      next.stage = 'sandbox';
    }
    const routeMatch = content.match(/\[HYDRA\]\s+Routing inference to\s+([A-Z0-9_]+)/);
    if (routeMatch) {
      next.activeProvider = routeMatch[1].toLowerCase();
      if (next.activeProvider !== 'freellmapi') {
        next.routedVia = null;
        next.upstreamRetries = null;
      }
    }
    const latencyMatch = content.match(/responded in\s+([\d.]+)ms/);
    if (latencyMatch) {
      next.lastLatencyMs = Number(latencyMatch[1]);
    }
    const freeViaMatch = content.match(/\[HYDRA\]\s+FREELLMAPI responded in\s+[\d.]+ms\s+via\s+([^\s(]+)(?:\s+\(upstream retries:\s*(\d+)\))?/);
    if (freeViaMatch) {
      next.activeProvider = 'freellmapi';
      next.routedVia = freeViaMatch[1];
      next.upstreamRetries = freeViaMatch[2] !== undefined ? Number(freeViaMatch[2]) : null;
    }
    if (content.includes('[HYDRA FAILOVER]')) {
      next.failoverCount += 1;
    }
  }

  return next;
}

/**
 * Splits buffered SSE stream text into parsed JSON event objects and remaining incomplete buffer.
 */
export function parseSseBuffer(buffer) {
  const frames = buffer.split('\n\n');
  const remainder = frames.pop() ?? '';
  const events = [];

  for (const frame of frames) {
    const lines = frame.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim();
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.content === 'string') {
            events.push(parsed);
          }
        } catch {
          // Ignore malformed partial frame
        }
      }
    }
  }

  return { events, remainder };
}
