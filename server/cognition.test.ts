import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { validateActorOutput, validateCriticVerdict } from './schemas';
import { HydraRouter, OfflineTaskQueue, createDefaultProviders, getGeminiApiKey, type ProviderAdapter } from './hydra';
import { EpisodicMemoryStore } from './memory';
import { LearningEngine } from './learning';
import { MutationEngine } from './mutation';
import { runCognitionLoop } from './cognition';
import { computeUnifiedDiff } from './sandbox';

test('Translation Layer rejects malformed JSON and invalid actions before execution', () => {
  const badJson = validateActorOutput('not valid json');
  assert.equal(badJson.ok, false);

  const missingCode = validateActorOutput(
    JSON.stringify({ thought: 'test', plan: [], action: 'run_python', code: '', target_file: null, response: '' })
  );
  assert.equal(missingCode.ok, false);

  const valid = validateActorOutput(
    '```json\n{"thought":"compute sum","plan":["run"],"action":"run_python","code":"print(2+2)","target_file":null,"response":"4"}\n```'
  );
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.data.action, 'run_python');
    assert.equal(valid.data.code, 'print(2+2)');
  }
});

test('CriticVerdict validator enforces strict {approved, faults, corrective_directive} contract', () => {
  const emptyReject = validateCriticVerdict(
    JSON.stringify({ approved: false, faults: [], corrective_directive: '' })
  );
  assert.equal(emptyReject.ok, false);

  const missingDirective = validateCriticVerdict(
    JSON.stringify({ approved: false, faults: ['No assertions'], corrective_directive: '   ' })
  );
  assert.equal(missingDirective.ok, false);

  const validReject = validateCriticVerdict(
    JSON.stringify({
      approved: false,
      faults: ['Swallowed exception without assert'],
      corrective_directive: 'Add assert statements covering valid and invalid inputs.',
    })
  );
  assert.equal(validReject.ok, true);
  if (validReject.ok) {
    assert.equal(validReject.data.approved, false);
    assert.deepEqual(validReject.data.faults, ['Swallowed exception without assert']);
  }

  const validApprove = validateCriticVerdict(
    JSON.stringify({ approved: true, faults: [], corrective_directive: '' })
  );
  assert.equal(validApprove.ok, true);
});

test('Gemini provider activates via GOOGLE_API_KEY fallback when GEMINI_API_KEY is unset', () => {
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_API_KEY = 'test-google-key-123';
    assert.equal(getGeminiApiKey(), 'test-google-key-123');
    const gemini = createDefaultProviders().find((p) => p.name === 'gemini');
    assert.ok(gemini);
    assert.equal(gemini.isConfigured(), true);
  } finally {
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
    if (prevGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = prevGoogle;
  }
});

test('HydraRouter cascades on 429/DNS fault to next healthy provider', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-hydra-'));
  const events: Array<{ type: string; content: string }> = [];

  const failingPrimary: ProviderAdapter = {
    name: 'gemini',
    tier: 'TIER_0',
    model: 'gemini-4-hydrogen',
    isConfigured: () => true,
    async invoke() {
      throw new Error('HTTP 429: Rate limit exceeded');
    },
  };

  const healthyFallback: ProviderAdapter = {
    name: 'groq',
    tier: 'TIER_0',
    model: 'llama-3.3-70b-versatile',
    isConfigured: () => true,
    async invoke() {
      return { text: '{"thought":"ok","plan":[],"action":"respond","code":"","target_file":null,"response":"done"}', tokens: 12 };
    },
  };

  const router = new HydraRouter(
    [failingPrimary, healthyFallback],
    new OfflineTaskQueue(path.join(tmpDir, 'queue.json'))
  );

  const result = await router.complete(
    [{ role: 'user', content: 'ping' }],
    true,
    (type, content) => events.push({ type, content })
  );

  assert.equal(result.provider, 'groq');
  assert.ok(events.some((e) => e.content.includes('HYDRA FAILOVER') && e.content.includes('GEMINI')));
});

test('Cognition Loop routes through Adversarial Critic on Exit 0 and rejects cheating scripts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-adv-'));
  const events: Array<{ type: string; content: string }> = [];
  let actorCalls = 0;
  let criticCalls = 0;

  const mockProvider: ProviderAdapter = {
    name: 'gemini',
    tier: 'TIER_0',
    model: 'gemini-4-hydrogen',
    isConfigured: () => true,
    async invoke(messages) {
      const sys = messages[0]?.content || '';
      if (sys.includes('Adversarial Critic')) {
        criticCalls += 1;
        if (criticCalls === 1) {
          return {
            text: JSON.stringify({
              approved: false,
              faults: [
                'Script exited 0 by swallowing exception in bare try/except without assertions.',
                'Missing edge-case validation asserts.',
              ],
              corrective_directive: 'Remove bare try/except swallowing and add explicit assert checks for valid and malformed inputs.',
            }),
            tokens: 24,
          };
        }
        return {
          text: JSON.stringify({
            approved: true,
            faults: [],
            corrective_directive: '',
          }),
          tokens: 14,
        };
      }

      actorCalls += 1;
      if (actorCalls === 1) {
        return {
          text: JSON.stringify({
            thought: 'Cheating Exit-0 attempt swallowing error',
            plan: ['wrap in try/except'],
            action: 'run_python',
            code: 'try:\n    int("bad")\nexcept Exception:\n    pass\nprint("all good")',
            target_file: null,
            response: 'Done',
          }),
          tokens: 20,
        };
      }
      assert.ok(messages[1].content.includes('Swallowing') || messages[1].content.includes('CRITIC DIRECTIVE'));
      return {
        text: JSON.stringify({
          thought: 'Write strict assertions for valid and invalid inputs',
          plan: ['assert valid parse', 'assert ValueError on invalid parse'],
          action: 'run_python',
          code: 'assert int("42") == 42\nraised = False\ntry:\n    int("bad")\nexcept ValueError:\n    raised = True\nassert raised\nprint("verified")',
          target_file: null,
          response: 'Verified with explicit assertions.',
        }),
        tokens: 25,
      };
    },
  };

  const router = new HydraRouter([mockProvider], new OfflineTaskQueue(path.join(tmpDir, 'queue.json')));
  const memory = new EpisodicMemoryStore(path.join(tmpDir, 'memory.json'));

  const mut1 = new MutationEngine(tmpDir);
  const res = await runCognitionLoop({
    task: 'Validate integer parsing for valid and malformed inputs',
    maxIterations: 4,
    mode: 'live',
    router,
    memory,
    mutationEngine: mut1,
    learningEngine: new LearningEngine({ knowledgePath: path.join(tmpDir, 'knowledge.json'), mutationEngine: mut1 }),
    emit: (type, content) => events.push({ type, content }),
  });

  assert.equal(res.status, 'verified');
  assert.equal(res.iterations, 2);
  assert.equal(actorCalls, 2);
  assert.equal(criticCalls, 2);
  assert.ok(events.some((e) => e.type === 'telemetry' && e.content.includes('[HYDRA]')));
  assert.ok(events.some((e) => e.type === 'critic' && e.content.includes('[CRITIC REJECTED]') && e.content.includes('Directive:')));
  assert.ok(events.some((e) => e.type === 'critic' && e.content.includes('[CRITIC APPROVED]')));
});

test('Cognition Loop catches Python traceback via Critic and self-heals on retry', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-cog-'));
  const events: Array<{ type: string; content: string }> = [];
  let actorCalls = 0;

  const mockProvider: ProviderAdapter = {
    name: 'gemini',
    tier: 'TIER_0',
    model: 'gemini-4-hydrogen',
    isConfigured: () => true,
    async invoke(messages) {
      const sys = messages[0]?.content || '';
      if (sys.includes('Adversarial Critic')) {
        const user = messages[1]?.content || '';
        if (user.includes('SANDBOX EXIT CODE: 0')) {
          return {
            text: JSON.stringify({ approved: true, faults: [], corrective_directive: '' }),
            tokens: 12,
          };
        }
        return {
          text: JSON.stringify({
            approved: false,
            faults: ['ZeroDivisionError: division by zero'],
            corrective_directive: 'Replace division by zero with guarded computation and assert output.',
          }),
          tokens: 20,
        };
      }

      actorCalls += 1;
      if (actorCalls === 1) {
        return {
          text: JSON.stringify({
            thought: 'Initial attempt with ZeroDivisionError',
            plan: ['run'],
            action: 'run_python',
            code: 'print(1 / 0)',
            target_file: null,
            response: '',
          }),
          tokens: 20,
        };
      }
      return {
        text: JSON.stringify({
          thought: 'Fix division by zero per Critic directive',
          plan: ['run fixed'],
          action: 'run_python',
          code: 'val = 42\nassert val == 42\nprint(val)',
          target_file: null,
          response: 'Verified output 42',
        }),
        tokens: 20,
      };
    },
  };

  const router = new HydraRouter([mockProvider], new OfflineTaskQueue(path.join(tmpDir, 'queue.json')));
  const memory = new EpisodicMemoryStore(path.join(tmpDir, 'memory.json'));

  const mut2 = new MutationEngine(tmpDir);
  const res = await runCognitionLoop({
    task: 'Compute verified numeric result',
    maxIterations: 4,
    mode: 'live',
    router,
    memory,
    mutationEngine: mut2,
    learningEngine: new LearningEngine({ knowledgePath: path.join(tmpDir, 'knowledge.json'), mutationEngine: mut2 }),
    emit: (type, content) => events.push({ type, content }),
  });

  assert.equal(res.status, 'verified');
  assert.equal(res.iterations, 2);
  assert.equal(res.finalResponse, 'Verified output 42');
  assert.ok(events.some((e) => e.type === 'critic' && e.content.includes('[CRITIC REJECTED]')));
  assert.ok(events.some((e) => e.type === 'critic' && e.content.includes('[CRITIC APPROVED]')));
  const recalled = await memory.recall('Compute verified numeric', 3);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].error_signature, 'resolved_self_heal');
});

test('Cognition Loop rejects script printing fabricated Episodic Memory Log JSON even if Critic model approves', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-memleak-'));
  const events: Array<{ type: string; content: string }> = [];
  let actorCalls = 0;

  const mockProvider: ProviderAdapter = {
    name: 'gemini',
    tier: 'TIER_0',
    model: 'gemini-4-hydrogen',
    isConfigured: () => true,
    async invoke(messages) {
      const sys = messages[0]?.content || '';
      if (sys.includes('Adversarial Critic')) {
        return {
          text: JSON.stringify({ approved: true, faults: [], corrective_directive: '' }),
          tokens: 10,
        };
      }
      actorCalls += 1;
      if (actorCalls === 1) {
        return {
          text: JSON.stringify({
            thought: 'Print fake memory JSON',
            plan: ['print'],
            action: 'run_python',
            code: 'assert 1 + 1 == 2\nprint("Episodic Memory Log: {}")',
            target_file: null,
            response: 'done',
          }),
          tokens: 15,
        };
      }
      return {
        text: JSON.stringify({
          thought: 'Clean verified script without fake memory printing',
          plan: ['assert'],
          action: 'run_python',
          code: 'assert 1 + 1 == 2\nprint(2)',
          target_file: null,
          response: 'Verified 2',
        }),
        tokens: 15,
      };
    },
  };

  const router = new HydraRouter([mockProvider], new OfflineTaskQueue(path.join(tmpDir, 'queue.json')));
  const memory = new EpisodicMemoryStore(path.join(tmpDir, 'memory.json'));

  const mut3 = new MutationEngine(tmpDir);
  const res = await runCognitionLoop({
    task: 'Add 1 + 1 cleanly',
    maxIterations: 3,
    mode: 'live',
    router,
    memory,
    mutationEngine: mut3,
    learningEngine: new LearningEngine({ knowledgePath: path.join(tmpDir, 'knowledge.json'), mutationEngine: mut3 }),
    emit: (type, content) => events.push({ type, content }),
  });

  assert.equal(res.status, 'verified');
  assert.equal(res.iterations, 2);
  assert.ok(events.some((e) => e.type === 'critic' && e.content.includes('Episodic Memory Log')));
});

test('Cognition Loop persists task to Tier 3 offline queue when all providers fail', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-tier3-'));
  const events: Array<{ type: string; content: string }> = [];
  const queue = new OfflineTaskQueue(path.join(tmpDir, 'queue.json'));

  const brokenProvider: ProviderAdapter = {
    name: 'gemini',
    tier: 'TIER_0',
    model: 'gemini-4-hydrogen',
    isConfigured: () => true,
    async invoke() {
      throw new Error('getaddrinfo ENOTFOUND generativelanguage.googleapis.com');
    },
  };

  const router = new HydraRouter([brokenProvider], queue);
  const memory = new EpisodicMemoryStore(path.join(tmpDir, 'memory.json'));

  const mut4 = new MutationEngine(tmpDir);
  const res = await runCognitionLoop({
    task: 'Offline resilience check',
    mode: 'live',
    router,
    memory,
    mutationEngine: mut4,
    learningEngine: new LearningEngine({ knowledgePath: path.join(tmpDir, 'knowledge.json'), mutationEngine: mut4 }),
    emit: (type, content) => events.push({ type, content }),
  });

  assert.equal(res.status, 'queued');
  assert.equal(await queue.pendingCount(), 1);
  assert.ok(events.some((e) => e.type === 'error' && e.content.includes('TIER 3 QUEUE')));
});

test('Unified diff helper formats mutation headers and line deltas', () => {
  const diff = computeUnifiedDiff('demo.py', 'x = 1\n', 'x = 2\n');
  assert.ok(diff.includes('--- a/demo.py'));
  assert.ok(diff.includes('+++ b/demo.py'));
  assert.ok(diff.includes('-x = 1'));
  assert.ok(diff.includes('+x = 2'));
});

test('validateActorOutput parses JSON header + fenced Python block with raw regex backslashes cleanly', () => {
  const raw = [
    '```json',
    '{"thought":"Parse digits with regex","plan":["compile regex","assert cases"],"action":"run_python","target_file":null,"response":"ok"}',
    '```',
    '',
    '```python',
    'import re',
    'assert re.match(r"^\\d+$", "42")',
    'print("digits ok")',
    '```',
  ].join('\n');

  const parsed = validateActorOutput(raw);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.data.action, 'run_python');
    assert.ok(parsed.data.code.includes('r"^\\d+$"'));
    assert.ok(!parsed.data.code.includes('```'));
  }
});

test('HydraRouter retries same provider without jsonMode on HTTP 400 json_validate_failed before cascading', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-repair-'));
  const events: Array<{ type: string; content: string }> = [];
  const calls: boolean[] = [];

  const groqMock: ProviderAdapter = {
    name: 'groq',
    tier: 'TIER_0',
    model: 'llama-3.3-70b-versatile',
    isConfigured: () => true,
    async invoke(_messages, jsonMode) {
      calls.push(jsonMode);
      if (jsonMode) {
        throw new Error('HTTP 400: {"error":{"code":"json_validate_failed","message":"Failed to generate JSON"}}');
      }
      return {
        text: JSON.stringify({ approved: true, faults: [], corrective_directive: '' }),
        tokens: 18,
      };
    },
  };

  const router = new HydraRouter([groqMock], new OfflineTaskQueue(path.join(tmpDir, 'queue.json')));
  const completion = await router.complete(
    [{ role: 'user', content: 'audit' }],
    true,
    (type, content) => events.push({ type, content })
  );

  assert.equal(completion.provider, 'groq');
  assert.deepEqual(calls, [true, false]);
  assert.ok(events.some((e) => e.content.includes('[HYDRA REPAIR]')));
  assert.equal(router.getProviderStatuses()[0].healthy, true);
});

test('Gemini provider activates via API_KEY alias when GEMINI_API_KEY and GOOGLE_API_KEY are unset', () => {
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  const prevApiKey = process.env.API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    process.env.API_KEY = 'test-api-key-alias';
    assert.equal(getGeminiApiKey(), 'test-api-key-alias');
    const gemini = createDefaultProviders().find((p) => p.name === 'gemini');
    assert.ok(gemini);
    assert.equal(gemini.isConfigured(), true);
  } finally {
    if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGemini;
    if (prevGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = prevGoogle;
    if (prevApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = prevApiKey;
  }
});

test('Cognition Loop executes Actor with jsonMode=false, performs same-provider schema repair, and recalls verified_run strategies', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-mem-scope-'));
  const events: Array<{ type: string; content: string }> = [];
  const memory = new EpisodicMemoryStore(path.join(tmpDir, 'memory.json'));

  await memory.recordEpisode({
    task_type: 'run_python',
    task_summary: 'Parse ISO-8601 timestamps cleanly',
    error_signature: 'verified_run',
    winning_strategy: 'assert parse_iso("2026-01-01T00:00:00Z") is not None',
  });

  const actorJsonModes: boolean[] = [];
  let actorAttempt = 0;
  let seenMemoryInPrompt = false;

  const mockProvider: ProviderAdapter = {
    name: 'groq',
    tier: 'TIER_0',
    model: 'llama-3.3-70b-versatile',
    isConfigured: () => true,
    async invoke(messages, jsonMode) {
      const sys = messages[0]?.content || '';
      if (sys.includes('Adversarial Critic')) {
        return {
          text: JSON.stringify({ approved: true, faults: [], corrective_directive: '' }),
          tokens: 12,
        };
      }
      actorJsonModes.push(jsonMode);
      actorAttempt += 1;
      if (messages[1]?.content.includes('Past Winning Strategy (verified_run)')) {
        seenMemoryInPrompt = true;
      }
      if (actorAttempt === 1) {
        return { text: 'malformed output without json header', tokens: 8 };
      }
      return {
        text: '```json\n{"thought":"Compute factorial","plan":["assert"],"action":"run_python","target_file":null,"response":"ok"}\n```\n```python\nassert 2 * 3 == 6\nprint(6)\n```',
        tokens: 20,
      };
    },
  };

  const router = new HydraRouter([mockProvider], new OfflineTaskQueue(path.join(tmpDir, 'queue.json')));
  const mut5 = new MutationEngine(tmpDir);
  const res = await runCognitionLoop({
    task: 'Compute factorial of 3',
    maxIterations: 2,
    mode: 'live',
    router,
    memory,
    mutationEngine: mut5,
    learningEngine: new LearningEngine({ knowledgePath: path.join(tmpDir, 'knowledge.json'), mutationEngine: mut5 }),
    emit: (type, content) => events.push({ type, content }),
  });

  assert.equal(res.status, 'verified');
  assert.equal(res.iterations, 1);
  assert.deepEqual(actorJsonModes, [false, false]);
  assert.equal(seenMemoryInPrompt, true);
  assert.ok(events.some((e) => e.type === 'memory' && e.content.includes('[MEMORY HIT]')));
  assert.ok(events.some((e) => e.content.includes('[TRANSLATION LAYER] Schema repair retry')));
});

test('Translation Layer & Critic parser strip nested/unclosed/mislabeled fences and extract first valid JSON object', async () => {
  // 1. Nested ```python inside JSON string field wrapped in outer ```json fence
  const nestedFenceActor = validateActorOutput(
    [
      '```json',
      '{"thought":"Run verified snippet","plan":["verify"],"action":"run_python","code":"```python\\nd = {1: 2}\\nassert d[1] == 2\\n```","target_file":null,"response":"ok"}',
      '```',
    ].join('\n')
  );
  assert.equal(nestedFenceActor.ok, true);
  if (nestedFenceActor.ok) {
    assert.equal(nestedFenceActor.data.action, 'run_python');
    assert.ok(nestedFenceActor.data.code.includes('assert d[1] == 2'));
    assert.equal(nestedFenceActor.data.code.includes('```'), false);
  }

  // 2. Unclosed leading fence + prose with invalid {not json} before real Critic verdict
  const messyCritic = validateCriticVerdict(
    'Here is {invalid} audit:\n```json\n{"approved": true, "faults": [], "corrective_directive": ""}\nNote: {trailing}'
  );
  assert.equal(messyCritic.ok, true);
  if (messyCritic.ok) {
    assert.equal(messyCritic.data.approved, true);
  }

  // 3. Double-fenced / mislabeled fence
  const doubleFencedCritic = validateCriticVerdict(
    '```\n```python\n{"approved": false, "faults": ["Missing asserts"], "corrective_directive": "Add asserts"}\n```\n```'
  );
  assert.equal(doubleFencedCritic.ok, true);
  if (doubleFencedCritic.ok) {
    assert.equal(doubleFencedCritic.data.approved, false);
    assert.deepEqual(doubleFencedCritic.data.faults, ['Missing asserts']);
  }

  // 4. End-to-end cognition loop: fenced Critic JSON succeeds on attempt 1 with ZERO wasted repair retries
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'raone-fence-'));
  let criticCalls = 0;
  const mockGroq: ProviderAdapter = {
    name: 'groq',
    tier: 'TIER_0',
    model: 'llama-3.3-70b-versatile',
    isConfigured: () => true,
    async invoke(messages) {
      const sys = messages[0]?.content || '';
      if (sys.includes('Adversarial Critic')) {
        criticCalls += 1;
        return {
          text: '```json\n{\n  "approved": true,\n  "faults": [],\n  "corrective_directive": ""\n}\n```\nDone auditing.',
          tokens: 16,
        };
      }
      return {
        text: '```json\n{"thought":"Verify math","plan":["assert"],"action":"run_python","target_file":null,"response":"4"}\n```\n```python\nassert 2 + 2 == 4\nprint(4)\n```',
        tokens: 20,
      };
    },
  };

  const router = new HydraRouter([mockGroq], new OfflineTaskQueue(path.join(tmpDir, 'queue.json')));
  const mut = new MutationEngine(tmpDir);
  const res = await runCognitionLoop({
    task: 'Compute 2 + 2',
    maxIterations: 2,
    mode: 'live',
    router,
    memory: new EpisodicMemoryStore(path.join(tmpDir, 'memory.json')),
    mutationEngine: mut,
    learningEngine: new LearningEngine({ knowledgePath: path.join(tmpDir, 'knowledge.json'), mutationEngine: mut }),
    emit: () => {},
  });

  assert.equal(res.status, 'verified');
  assert.equal(criticCalls, 1);
});


