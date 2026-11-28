export type SSEEventType =
  | 'telemetry'
  | 'memory'
  | 'actor'
  | 'code'
  | 'critic'
  | 'error'
  | 'final';

export interface SSEEvent {
  type: SSEEventType;
  content: string;
}

export type ActorAction =
  | 'run_python'
  | 'mutate_code'
  | 'audit_code'
  | 'respond'
  | 'web_search'
  | 'scrape_url'
  | 'research_topic'
  | 'promote_tool';

export interface ActorOutput {
  thought: string;
  plan: string[];
  action: ActorAction;
  code: string;
  target_file: string | null;
  query?: string | null;
  url?: string | null;
  tool_name?: string | null;
  tool_description?: string | null;
  response: string;
}

export interface CriticVerdict {
  approved: boolean;
  faults: string[];
  corrective_directive: string;
}

export type DegradationTier = 'TIER_0' | 'TIER_1' | 'TIER_2' | 'TIER_3';

export interface HydraProviderStatus {
  name: string;
  tier: DegradationTier;
  configured: boolean;
  healthy: boolean;
  model: string;
  last_error: string | null;
  last_latency_ms: number | null;
}

export interface HealthDiagnostics {
  status: 'online' | 'degraded' | 'offline';
  core: string;
  active_tier: DegradationTier;
  active_provider: string | null;
  uptime_seconds: number;
  providers: HydraProviderStatus[];
  episodic_memory: {
    backend: string;
    supabase_configured: boolean;
    episode_count: number;
  };
  sandbox: {
    ready: boolean;
    python_executable: string;
    timeout_seconds: number;
  };
  offline_queue_depth: number;
  web_engine: 'ready';
  learned_tools: string[];
  learned_tools_count: number;
  knowledge_docs: number;
  knowledge_docs_count: number;
  snapshots_count: number;
  freellmapi: 'ready' | 'unreachable' | 'unconfigured';
  freellmapi_models_available: number;
  last_routed_via: string | null;
}

const VALID_ACTIONS = new Set<ActorAction>([
  'run_python',
  'mutate_code',
  'audit_code',
  'respond',
  'web_search',
  'scrape_url',
  'research_topic',
  'promote_tool',
]);

export function stripCodeFences(raw: string): string {
  let cleaned = raw.trim();
  for (let i = 0; i < 3; i += 1) {
    const wrapped = cleaned.match(/^(?:```+|~~~+)(?:[a-zA-Z0-9_-]+)?[ \t]*\r?\n([\s\S]*?)\r?\n?(?:```+|~~~+)\s*$/);
    if (wrapped?.[1] !== undefined) {
      cleaned = wrapped[1].trim();
      continue;
    }
    const inlineWrapped = cleaned.match(/^(?:```+|~~~+)(?:[a-zA-Z0-9_-]+)?[ \t]+([\s\S]*?)(?:```+|~~~+)\s*$/);
    if (inlineWrapped?.[1] !== undefined) {
      cleaned = inlineWrapped[1].trim();
      continue;
    }
    break;
  }
  cleaned = cleaned.replace(/^(?:```+|~~~+)(?:[a-zA-Z0-9_-]+)?[ \t]*(?:\r?\n)?/, '');
  cleaned = cleaned.replace(/(?:\r?\n)?[ \t]*(?:```+|~~~+)\s*$/, '');
  return cleaned.trim();
}

function findFirstValidJsonObject(text: string): string | null {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j += 1) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return candidate;
            }
          } catch {
            // Keep scanning for the next balanced JSON object
          }
          break;
        }
      }
    }
  }
  return null;
}

export function extractJsonObject(raw: string): string {
  const stripped = stripCodeFences(raw);
  if (stripped.startsWith('{')) {
    const direct = findFirstValidJsonObject(stripped);
    if (direct) return direct;
  }

  for (const match of raw.matchAll(/(?:```+|~~~+)json[c]?[ \t]*\r?\n?([\s\S]*?)(?:```+|~~~+)/gi)) {
    const inner = stripCodeFences(match[1] ?? '');
    const found = findFirstValidJsonObject(inner);
    if (found) return found;
  }

  const linesWithoutFences = stripped.replace(/^[ \t]*(?:```+|~~~+)[a-zA-Z0-9_-]*[ \t]*$/gm, '').trim();
  const scanned = findFirstValidJsonObject(linesWithoutFences);
  if (scanned) return scanned;

  const fallback = findFirstValidJsonObject(stripped);
  if (fallback) return fallback;

  return linesWithoutFences || stripped;
}

function extractDelimitedPythonBlock(raw: string): string | null {
  const explicitMatch = raw.match(/===CODE_START===\s*([\s\S]*?)===CODE_END===/i);
  if (explicitMatch?.[1]?.trim()) {
    return stripCodeFences(explicitMatch[1]);
  }
  const pyFenceMatches = [...raw.matchAll(/```(?:python|py)\b[^\n]*\r?\n([\s\S]*?)```/gi)];
  if (pyFenceMatches.length > 0) {
    const last = pyFenceMatches[pyFenceMatches.length - 1]?.[1];
    if (last?.trim()) {
      return last.trim();
    }
  }
  return null;
}

function extractHeaderJsonBeforeCode(raw: string): string {
  const withoutPyBlock = raw
    .replace(/===CODE_START===[\s\S]*?===CODE_END===/gi, '')
    .replace(/```(?:python|py)\b[^\n]*\r?\n?[\s\S]*?```/gi, '')
    .trim();
  return extractJsonObject(withoutPyBlock || raw);
}

export function validateActorOutput(rawText: string): { ok: true; data: ActorOutput } | { ok: false; error: string } {
  const externalCode = extractDelimitedPythonBlock(rawText);
  const jsonText = externalCode ? extractHeaderJsonBeforeCode(rawText) : extractJsonObject(rawText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'ActorOutput must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.thought !== 'string' || !record.thought.trim()) {
    return { ok: false, error: 'Field "thought" must be a non-empty string.' };
  }

  if (typeof record.action !== 'string' || !VALID_ACTIONS.has(record.action as ActorAction)) {
    return {
      ok: false,
      error: `Field "action" must be one of: run_python, mutate_code, audit_code, web_search, scrape_url, research_topic, promote_tool, respond. Got: ${String(record.action)}`,
    };
  }

  const plan = Array.isArray(record.plan)
    ? record.plan.filter((item): item is string => typeof item === 'string')
    : [];

  const inlineCode = typeof record.code === 'string' ? stripCodeFences(record.code) : '';
  const code = externalCode ?? inlineCode;
  const target_file = typeof record.target_file === 'string' && record.target_file.trim()
    ? record.target_file.trim()
    : null;
  const query = typeof record.query === 'string' && record.query.trim() ? record.query.trim() : null;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url.trim() : null;
  const tool_name = typeof record.tool_name === 'string' && record.tool_name.trim() ? record.tool_name.trim() : null;
  const tool_description = typeof record.tool_description === 'string' && record.tool_description.trim() ? record.tool_description.trim() : null;
  const response = typeof record.response === 'string' ? record.response : '';

  if ((record.action === 'run_python' || record.action === 'promote_tool') && !code.trim()) {
    return { ok: false, error: `Action "${record.action}" requires non-empty "code" (provide a \`\`\`python ... \`\`\` block).` };
  }

  if (record.action === 'mutate_code' && (!code.trim() || !target_file)) {
    return { ok: false, error: 'Action "mutate_code" requires both "target_file" and non-empty "code".' };
  }

  if ((record.action === 'web_search' || record.action === 'research_topic') && !query) {
    return { ok: false, error: `Action "${record.action}" requires non-empty "query".` };
  }

  if (record.action === 'scrape_url' && !url) {
    return { ok: false, error: 'Action "scrape_url" requires non-empty "url".' };
  }

  if (record.action === 'promote_tool' && !tool_name) {
    return { ok: false, error: 'Action "promote_tool" requires non-empty "tool_name".' };
  }

  return {
    ok: true,
    data: {
      thought: record.thought.trim(),
      plan,
      action: record.action as ActorAction,
      code,
      target_file,
      query,
      url,
      tool_name,
      tool_description,
      response,
    },
  };
}

export function validateCriticVerdict(rawText: string): { ok: true; data: CriticVerdict } | { ok: false; error: string } {
  const jsonText = extractJsonObject(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `Invalid Critic JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'CriticVerdict must be a JSON object.' };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.approved !== 'boolean') {
    return { ok: false, error: 'Field "approved" must be a boolean.' };
  }

  if (!Array.isArray(record.faults) || !record.faults.every((item) => typeof item === 'string')) {
    return { ok: false, error: 'Field "faults" must be an array of strings.' };
  }

  if (typeof record.corrective_directive !== 'string') {
    return { ok: false, error: 'Field "corrective_directive" must be a string.' };
  }

  const faults = record.faults.map((f) => f.trim()).filter(Boolean);
  const corrective_directive = record.corrective_directive.trim();

  if (!record.approved && faults.length === 0) {
    return { ok: false, error: 'Rejected CriticVerdict must include at least one fault in "faults".' };
  }

  if (!record.approved && !corrective_directive) {
    return { ok: false, error: 'Rejected CriticVerdict must include a non-empty "corrective_directive".' };
  }

  return {
    ok: true,
    data: {
      approved: record.approved,
      faults,
      corrective_directive,
    },
  };
}

