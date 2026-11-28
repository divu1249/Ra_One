import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_RUN_METRICS, parseSseBuffer, reduceSseEvent } from './streamState.js';

test('parseSseBuffer extracts complete SSE JSON frames and preserves incomplete tail', () => {
  const chunk1 = 'data: {"type":"telemetry","content":"[HYDRA] Routing inference to GEMINI"}\n\ndata: {"type":"actor"';
  const r1 = parseSseBuffer(chunk1);
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].type, 'telemetry');
  assert.equal(r1.remainder, 'data: {"type":"actor"');

  const chunk2 = r1.remainder + ',"content":"[ACTOR] Iteration 2/5"}\n\n';
  const r2 = parseSseBuffer(chunk2);
  assert.equal(r2.events.length, 1);
  assert.equal(r2.events[0].type, 'actor');
  assert.equal(r2.remainder, '');
});

test('reduceSseEvent tracks cognitive stages, failovers, latency, and iterations', () => {
  let state = { ...INITIAL_RUN_METRICS };
  state = reduceSseEvent(state, { type: 'memory', content: '[MEMORY HIT] Recalled 1 episode(s): ZeroDivisionError' });
  assert.equal(state.stage, 'memory');
  assert.equal(state.recalledNotes.length, 1);

  state = reduceSseEvent(state, { type: 'actor', content: '[ACTOR] Iteration 2/5 — synthesizing' });
  assert.equal(state.stage, 'actor');
  assert.equal(state.iteration, 2);
  assert.equal(state.maxIterations, 5);

  state = reduceSseEvent(state, { type: 'telemetry', content: '[HYDRA FAILOVER] GEMINI fault. Cascading...' });
  assert.equal(state.failoverCount, 1);

  state = reduceSseEvent(state, { type: 'telemetry', content: '[HYDRA] GROQ responded in 142.5ms (~40 tokens).' });
  assert.equal(state.lastLatencyMs, 142.5);

  state = reduceSseEvent(state, { type: 'code', content: '-- SIMULATING MUTATION ON demo.py --\n+x = 2' });
  assert.equal(state.stage, 'mutate');

  state = reduceSseEvent(state, { type: 'final', content: 'Verified.' });
  assert.equal(state.stage, 'verified');
});

test('reduceSseEvent parses FreeLLMAPI X-Routed-Via and upstream retries telemetry', () => {
  let state = { ...INITIAL_RUN_METRICS };
  state = reduceSseEvent(state, {
    type: 'telemetry',
    content: '[HYDRA] Routing inference to FREELLMAPI (TIER_0 / auto:coding)',
  });
  assert.equal(state.activeProvider, 'freellmapi');

  state = reduceSseEvent(state, {
    type: 'telemetry',
    content: '[HYDRA] FREELLMAPI responded in 1420.5ms via groq/llama-4-scout (upstream retries: 1)',
  });
  assert.equal(state.activeProvider, 'freellmapi');
  assert.equal(state.lastLatencyMs, 1420.5);
  assert.equal(state.routedVia, 'groq/llama-4-scout');
  assert.equal(state.upstreamRetries, 1);

  state = reduceSseEvent(state, {
    type: 'telemetry',
    content: '[HYDRA] Routing inference to GEMINI (TIER_0 / gemini-4-hydrogen)',
  });
  assert.equal(state.activeProvider, 'gemini');
  assert.equal(state.routedVia, null);
  assert.equal(state.upstreamRetries, null);
});

