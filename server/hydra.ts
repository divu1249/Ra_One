import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DegradationTier, HydraProviderStatus, SSEEventType } from './schemas';

export type RoutingRole = 'actor' | 'critic' | 'fast';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface HydraCompletion {
  content: string;
  provider: string;
  model: string;
  tier: DegradationTier;
  latency_ms: number;
  tokens_estimated: number;
  routed_via?: string | null;
  fallback_attempts?: string | null;
}

export type TelemetryEmitter = (type: SSEEventType, content: string) => void;

export interface LowBandwidthRelayTransport {
  transmitCompact(summary: string): Promise<string | null>;
}

export const defaultNullRelay: LowBandwidthRelayTransport = {
  async transmitCompact() {
    return null;
  },
};

export interface QueuedOfflineTask {
  id: number;
  task: string;
  reason: string;
  created_at: number;
  status: 'queued' | 'flushed';
}

export class OfflineTaskQueue {
  private readonly filePath: string;
  private items: QueuedOfflineTask[] = [];
  private loaded = false;

  constructor(storagePath = path.resolve(process.cwd(), 'data', 'offline_queue.json')) {
    this.filePath = storagePath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.items = parsed;
    } catch {
      this.items = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.items, null, 2), 'utf-8');
  }

  async enqueue(task: string, reason: string): Promise<QueuedOfflineTask> {
    await this.ensureLoaded();
    const nextId = this.items.length > 0 ? this.items[this.items.length - 1].id + 1 : 1;
    const entry: QueuedOfflineTask = {
      id: nextId,
      task,
      reason: reason.slice(0, 300),
      created_at: Date.now() / 1000,
      status: 'queued',
    };
    this.items.push(entry);
    await this.persist();
    return entry;
  }

  async pendingCount(): Promise<number> {
    await this.ensureLoaded();
    return this.items.filter((i) => i.status === 'queued').length;
  }

  async listPending(): Promise<QueuedOfflineTask[]> {
    await this.ensureLoaded();
    return this.items.filter((i) => i.status === 'queued');
  }

  async markFlushed(id: number): Promise<void> {
    await this.ensureLoaded();
    this.items = this.items.map((item) => (item.id === id ? { ...item, status: 'flushed' } : item));
    await this.persist();
  }
}

export interface ProviderInvokeResult {
  text: string;
  tokens: number;
  modelUsed?: string;
  routedVia?: string | null;
  fallbackAttempts?: string | null;
}

export interface ProviderAdapter {
  name: string;
  tier: DegradationTier;
  model: string;
  isConfigured(): boolean;
  invoke(
    messages: ChatMessage[],
    jsonMode: boolean,
    maxTokens?: number,
    role?: RoutingRole,
    emit?: TelemetryEmitter
  ): Promise<ProviderInvokeResult>;
}

export function getGeminiApiKey(): string {
  return (
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.API_KEY?.trim() ||
    ''
  );
}

export function normalizeFreeLlmApiBaseUrl(rawUrl: string): string {
  let cleaned = rawUrl.trim().replace(/\/+$/, '');
  if (!cleaned) return '';
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  cleaned = cleaned.replace(/\/(?:chat\/completions|models)$/i, '').replace(/\/+$/, '');
  if (!cleaned.toLowerCase().endsWith('/v1')) {
    cleaned = `${cleaned}/v1`;
  }
  return cleaned;
}

export function isHtmlResponse(contentType: string, rawBody: string): boolean {
  const ct = contentType.toLowerCase();
  const trimmed = rawBody.trimStart();
  return ct.includes('text/html') || ct.includes('application/xhtml') || trimmed.startsWith('<');
}

function formatResponseSnippet(rawBody: string): string {
  return rawBody.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveFreeLlmApiModel(role: RoutingRole = 'actor'): string {
  if (role === 'critic') {
    return process.env.FREELLMAPI_MODEL_CRITIC?.trim() || 'auto:smart';
  }
  if (role === 'fast') {
    return process.env.FREELLMAPI_MODEL_FAST?.trim() || 'auto:fast';
  }
  return process.env.FREELLMAPI_MODEL_ACTOR?.trim() || 'auto:coding';
}

function isJsonValidateError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('json_validate_failed') ||
    lower.includes('failed_generation') ||
    (lower.includes('http 400') && lower.includes('json'))
  );
}

function isQuotaExceededBody(rawBody: string): boolean {
  const lower = rawBody.toLowerCase();
  if (lower.includes('quota_exceeded')) return true;
  try {
    const parsed = JSON.parse(rawBody) as { error?: { code?: string } };
    return String(parsed?.error?.code || '').toLowerCase() === 'quota_exceeded';
  } catch {
    return false;
  }
}

export function createDefaultProviders(): ProviderAdapter[] {
  return [
    {
      name: 'gemini',
      tier: 'TIER_0',
      model: 'gemini-4-hydrogen',
      isConfigured: () => Boolean(getGeminiApiKey()),
      async invoke(messages, jsonMode) {
        const apiKey = getGeminiApiKey();
        if (!apiKey) throw new Error('GEMINI_API_KEY / GOOGLE_API_KEY / API_KEY not configured');
        const ai = new GoogleGenAI({
          apiKey,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
        });
        const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const contents = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          }));

        try {
          const response = await ai.models.generateContent({
            model: 'gemini-4-hydrogen',
            contents,
            config: {
              ...(systemParts ? { systemInstruction: systemParts } : {}),
              ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
            },
          });
          const text = response.text ?? '';
          if (!text) throw new Error('Empty response from Gemini');
          return { text, tokens: Math.ceil(text.length / 4) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonMode && (msg.includes('400') || isJsonValidateError(msg))) {
            const fallbackResponse = await ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents,
              config: {
                ...(systemParts ? { systemInstruction: systemParts } : {}),
              },
            });
            const text = fallbackResponse.text ?? '';
            if (!text) throw new Error('Empty response from Gemini on schema fallback');
            return { text, tokens: Math.ceil(text.length / 4) };
          }
          throw err;
        }
      },
    },
    createOpenAICompatProvider('groq', 'TIER_0', 'llama-3.3-70b-versatile', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1/chat/completions'),
    createFreeLlmApiProvider(),
    createOpenAICompatProvider('deepseek', 'TIER_0', 'deepseek-chat', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/v1/chat/completions'),
    createOpenAICompatProvider('openrouter', 'TIER_0', 'meta-llama/llama-3.3-70b-instruct', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/chat/completions'),
    {
      name: 'local_slm',
      tier: 'TIER_1',
      model: process.env.LOCAL_LLM_MODEL?.trim() || 'llama3.2:3b',
      isConfigured: () => Boolean(process.env.LOCAL_LLM_URL?.trim()),
      async invoke(messages) {
        const base = process.env.LOCAL_LLM_URL?.trim() || '';
        if (!base) throw new Error('LOCAL_LLM_URL not configured');
        const endpoint = base.endsWith('/chat/completions')
          ? base
          : `${base.replace(/\/$/, '')}/v1/chat/completions`;
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, messages, temperature: 0.1 }),
          signal: AbortSignal.timeout(25_000),
        });
        if (resp.status === 429 || resp.status >= 500 || !resp.ok) {
          throw new Error(`HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
        const text = data.choices?.[0]?.message?.content ?? '';
        if (!text) throw new Error('Empty Local SLM response');
        return { text, tokens: data.usage?.total_tokens ?? Math.ceil(text.length / 4) };
      },
    },
  ];
}

export function createFreeLlmApiProvider(coldStartRetryDelayMs = 3000): ProviderAdapter {
  let lastModel = resolveFreeLlmApiModel('actor');

  return {
    name: 'freellmapi',
    tier: 'TIER_0',
    get model() {
      return lastModel;
    },
    isConfigured: () => {
      const base = normalizeFreeLlmApiBaseUrl(process.env.FREELLMAPI_BASE_URL || '');
      const key = process.env.FREELLMAPI_API_KEY?.trim() || '';
      return Boolean(base && key);
    },
    async invoke(messages, _jsonMode, maxTokens = 1400, role = 'actor', emit) {
      const base = normalizeFreeLlmApiBaseUrl(process.env.FREELLMAPI_BASE_URL || '');
      const apiKey = process.env.FREELLMAPI_API_KEY?.trim() || '';
      if (!base || !apiKey) {
        throw new Error('FREELLMAPI_BASE_URL / FREELLMAPI_API_KEY not configured');
      }

      const targetModel = resolveFreeLlmApiModel(role);
      lastModel = targetModel;
      const endpoint = `${base}/chat/completions`;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        // Zero-crash schema handling: do NOT force response_format on FreeLLMAPI upstream models
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: targetModel,
            messages,
            temperature: 0.1,
            max_tokens: maxTokens,
          }),
          signal: AbortSignal.timeout(35_000),
        });

        const rawBody = await resp.text().catch(() => '');
        const contentType = resp.headers.get('content-type') || '';
        const htmlBody = isHtmlResponse(contentType, rawBody);
        const snippet = formatResponseSnippet(rawBody);
        const isTransientColdStart = resp.status === 502 || resp.status === 503 || resp.status === 504;

        if (htmlBody || isTransientColdStart) {
          const logMsg = `[HYDRA] FREELLMAPI HTTP ${resp.status} (${htmlBody ? 'HTML' : contentType || 'transient'}): ${snippet || '(empty body)'}`;
          console.warn(logMsg);
          emit?.('telemetry', logMsg);

          if (isTransientColdStart && attempt === 0) {
            emit?.('telemetry', `[HYDRA] FREELLMAPI HTTP ${resp.status} cold-start detected; retrying once in ${Math.round(coldStartRetryDelayMs / 1000)}s...`);
            await sleepMs(coldStartRetryDelayMs);
            continue;
          }
          throw new Error(`HTTP ${resp.status} ${htmlBody ? 'HTML' : 'transient'} response from FreeLLMAPI: ${snippet}`);
        }

        if (resp.status === 429 || resp.status >= 500 || isQuotaExceededBody(rawBody) || !resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${snippet}`);
        }

        const routedVia = resp.headers.get('x-routed-via');
        const fallbackAttempts = resp.headers.get('x-fallback-attempts');

        let parsed: { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
        try {
          parsed = JSON.parse(rawBody);
        } catch (err) {
          throw new Error(`Invalid JSON from FreeLLMAPI (HTTP ${resp.status}): ${snippet || (err instanceof Error ? err.message : String(err))}`);
        }

        const text = parsed.choices?.[0]?.message?.content ?? '';
        if (!text) {
          throw new Error('Empty response from FreeLLMAPI');
        }

        return {
          text,
          tokens: parsed.usage?.total_tokens ?? Math.ceil(text.length / 4),
          modelUsed: targetModel,
          routedVia,
          fallbackAttempts,
        };
      }

      throw new Error('FreeLLMAPI failed after cold-start retry');
    },
  };
}

function createOpenAICompatProvider(
  name: string,
  tier: DegradationTier,
  defaultModel: string,
  envKey: string,
  endpoint: string
): ProviderAdapter {
  let resolvedModel = defaultModel;
  let candidateModels: string[] = [defaultModel];
  let modelDiscovered = name !== 'groq';

  return {
    name,
    tier,
    get model() {
      return resolvedModel;
    },
    isConfigured: () => Boolean(process.env[envKey]?.trim()),
    async invoke(messages, jsonMode, maxTokens = 1400) {
      const apiKey = process.env[envKey]?.trim();
      if (!apiKey) throw new Error(`${envKey} not configured`);

      if (!modelDiscovered && name === 'groq') {
        try {
          const modelsResp = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(8_000),
          });
          if (modelsResp.ok) {
            const modelsData = (await modelsResp.json()) as { data?: Array<{ id?: string }> };
            const ids = (modelsData.data ?? [])
              .map((m) => m.id ?? '')
              .filter((id) => {
                const lower = id.toLowerCase();
                if (!id) return false;
                if (
                  lower.includes('guard') ||
                  lower.includes('whisper') ||
                  lower.includes('tts') ||
                  lower.includes('orpheus') ||
                  lower.includes('playai') ||
                  lower.includes('canopylabs') ||
                  lower.includes('compound')
                ) {
                  return false;
                }
                return (
                  lower.includes('llama') ||
                  lower.includes('qwen') ||
                  lower.includes('mixtral') ||
                  lower.includes('gemma') ||
                  lower.includes('deepseek') ||
                  lower.includes('gpt-oss')
                );
              });
            const prefs = ['llama-3.3', 'llama3-70b', 'llama-3.1', 'llama-3.', 'qwen', 'gpt-oss', 'mixtral', 'gemma'];
            const ordered: string[] = [];
            for (const pref of prefs) {
              for (const id of ids) {
                if (id.toLowerCase().includes(pref) && !ordered.includes(id)) {
                  ordered.push(id);
                }
              }
            }
            for (const id of ids) {
              if (!ordered.includes(id)) ordered.push(id);
            }
            if (ordered.length > 0) {
              candidateModels = ordered;
              resolvedModel = ordered[0];
            }
          }
        } catch {
          // Keep defaultModel if model discovery fails
        } finally {
          modelDiscovered = true;
        }
      }

      const modelsToTry = name === 'groq' ? candidateModels.slice(0, 3) : [resolvedModel];
      let lastErr: Error | null = null;

      for (const candidateModel of modelsToTry) {
        const useJsonFormat =
          jsonMode && (name === 'groq' || name === 'deepseek') && !candidateModel.toLowerCase().includes('qwen');

        const sendRequest = async (enforceJsonFormat: boolean, reqMessages: ChatMessage[]) => {
          const body: Record<string, unknown> = {
            model: candidateModel,
            messages: reqMessages,
            temperature: 0.1,
            max_tokens: maxTokens,
          };
          if (enforceJsonFormat) {
            body.response_format = { type: 'json_object' };
          }
          return fetch(endpoint, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(25_000),
          });
        };

        let resp = await sendRequest(useJsonFormat, messages);

        if (resp.status === 400 && useJsonFormat) {
          const detail = await resp.text().catch(() => '');
          if (isJsonValidateError(`HTTP 400: ${detail}`)) {
            const repairedMessages: ChatMessage[] = [
              ...messages,
              {
                role: 'user',
                content:
                  `Previous JSON validator rejected strict schema (${detail.slice(0, 120)}). Return plain text containing only the valid JSON object.`,
              },
            ];
            resp = await sendRequest(false, repairedMessages);
          } else {
            lastErr = new Error(`HTTP 400: ${detail.slice(0, 160)}`);
            throw lastErr;
          }
        }

        if (resp.status === 429 || resp.status === 404 || resp.status >= 500 || !resp.ok) {
          const detail = await resp.text().catch(() => '');
          lastErr = new Error(`HTTP ${resp.status}: ${detail.slice(0, 160)}`);
          if (
            name === 'groq' &&
            (resp.status === 429 || resp.status === 404 || detail.toLowerCase().includes('terms'))
          ) {
            continue;
          }
          throw lastErr;
        }
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
        const text = data.choices?.[0]?.message?.content ?? '';
        if (!text) {
          lastErr = new Error(`Empty response from ${name}`);
          continue;
        }
        resolvedModel = candidateModel;
        return { text, tokens: data.usage?.total_tokens ?? Math.ceil(text.length / 4) };
      }

      throw lastErr ?? new Error(`All candidate models failed for ${name}`);
    },
  };
}

export class HydraRouter {
  readonly providers: ProviderAdapter[];
  readonly queue: OfflineTaskQueue;
  private readonly relay: LowBandwidthRelayTransport;
  private readonly healthMap = new Map<string, { healthy: boolean; last_error: string | null; last_latency_ms: number | null }>();
  activeProvider: string | null = null;
  activeTier: DegradationTier = 'TIER_0';
  lastRoutedVia: string | null = null;
  private freeLlmProbeCache: { status: 'ready' | 'unreachable' | 'unconfigured'; models_available: number } | null = null;
  private freeLlmProbeTs = 0;

  constructor(
    providers: ProviderAdapter[] = createDefaultProviders(),
    queue: OfflineTaskQueue = new OfflineTaskQueue(),
    relay: LowBandwidthRelayTransport = defaultNullRelay
  ) {
    this.providers = providers;
    this.queue = queue;
    this.relay = relay;
    for (const p of providers) {
      this.healthMap.set(p.name, {
        healthy: p.isConfigured(),
        last_error: null,
        last_latency_ms: null,
      });
    }
  }

  private getOrderedProviders(preferredProvider?: string | null): ProviderAdapter[] {
    const priority = (process.env.FREELLMAPI_PRIORITY || 'overflow').trim().toLowerCase();
    let ordered = [...this.providers];
    if (priority === 'primary') {
      const freeOnes = ordered.filter((p) => p.name === 'freellmapi');
      const rest = ordered.filter((p) => p.name !== 'freellmapi');
      ordered = [...freeOnes, ...rest];
    }
    if (preferredProvider) {
      return [
        ...ordered.filter((p) => p.name === preferredProvider),
        ...ordered.filter((p) => p.name !== preferredProvider),
      ];
    }
    return ordered;
  }

  async probeFreeLlmApiHealth(force = false): Promise<{
    status: 'ready' | 'unreachable' | 'unconfigured';
    models_available: number;
    last_routed_via: string | null;
  }> {
    const base = normalizeFreeLlmApiBaseUrl(process.env.FREELLMAPI_BASE_URL || '');
    const apiKey = process.env.FREELLMAPI_API_KEY?.trim() || '';
    if (!base || !apiKey) {
      return {
        status: 'unconfigured',
        models_available: 0,
        last_routed_via: this.lastRoutedVia,
      };
    }

    const now = Date.now();
    if (!force && this.freeLlmProbeCache && now - this.freeLlmProbeTs < 30_000) {
      return {
        ...this.freeLlmProbeCache,
        last_routed_via: this.lastRoutedVia,
      };
    }

    let status: 'ready' | 'unreachable' = 'unreachable';
    let modelsAvailable = 0;

    try {
      const resp = await fetch(`${base}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      const rawBody = await resp.text().catch(() => '');
      const contentType = resp.headers.get('content-type') || '';
      const htmlBody = isHtmlResponse(contentType, rawBody);
      const snippet = formatResponseSnippet(rawBody);

      if (htmlBody) {
        const msg = `Probe HTTP ${resp.status} HTML response: ${snippet || '(empty)'}`;
        console.warn(`[HYDRA] FREELLMAPI ${msg}`);
        this.healthMap.set('freellmapi', {
          healthy: false,
          last_error: msg.slice(0, 180),
          last_latency_ms: null,
        });
      } else if (resp.ok) {
        const data = JSON.parse(rawBody) as { data?: unknown[]; models?: unknown[] };
        const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        status = 'ready';
        modelsAvailable = list.length;
        this.healthMap.set('freellmapi', {
          healthy: true,
          last_error: null,
          last_latency_ms: this.healthMap.get('freellmapi')?.last_latency_ms ?? null,
        });
      } else {
        this.healthMap.set('freellmapi', {
          healthy: false,
          last_error: `Probe HTTP ${resp.status}${snippet ? `: ${snippet}` : ''}`.slice(0, 180),
          last_latency_ms: null,
        });
      }
    } catch (err) {
      this.healthMap.set('freellmapi', {
        healthy: false,
        last_error: `Probe error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
        last_latency_ms: null,
      });
    }

    this.freeLlmProbeCache = { status, models_available: modelsAvailable };
    this.freeLlmProbeTs = now;
    return {
      status,
      models_available: modelsAvailable,
      last_routed_via: this.lastRoutedVia,
    };
  }

  getProviderStatuses(): HydraProviderStatus[] {
    return this.getOrderedProviders().map((p) => {
      const configured = p.isConfigured();
      const state = this.healthMap.get(p.name) ?? { healthy: configured, last_error: null, last_latency_ms: null };
      const healthy = configured && (state.healthy || (state.last_error === null && state.last_latency_ms === null));
      return {
        name: p.name,
        tier: p.tier,
        configured,
        healthy,
        model: p.name === 'freellmapi' ? resolveFreeLlmApiModel('actor') : p.model,
        last_error: state.last_error,
        last_latency_ms: state.last_latency_ms,
      };
    });
  }

  currentTier(): DegradationTier {
    for (const p of this.getOrderedProviders()) {
      const configured = p.isConfigured();
      const state = this.healthMap.get(p.name);
      const healthy = configured && (!state || state.healthy || (state.last_error === null && state.last_latency_ms === null));
      if (healthy) {
        return p.tier;
      }
    }
    return 'TIER_3';
  }

  async complete(
    messages: ChatMessage[],
    jsonMode = true,
    emit?: TelemetryEmitter,
    maxTokens = 1400,
    preferredProvider?: string | null,
    role: RoutingRole = 'actor'
  ): Promise<HydraCompletion> {
    const errors: string[] = [];
    const orderedProviders = this.getOrderedProviders(preferredProvider);

    for (const provider of orderedProviders) {
      if (!provider.isConfigured()) continue;

      const displayModel = provider.name === 'freellmapi' ? resolveFreeLlmApiModel(role) : provider.model;
      emit?.('telemetry', `[HYDRA] Routing inference to ${provider.name.toUpperCase()} (${provider.tier} / ${displayModel})`);
      const started = performance.now();

      const invokeWithSchemaFallback = async (): Promise<ProviderInvokeResult> => {
        try {
          return await provider.invoke(messages, jsonMode, maxTokens, role, emit);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (jsonMode && isJsonValidateError(msg)) {
            emit?.('telemetry', `[HYDRA REPAIR] ${provider.name.toUpperCase()} rejected strict JSON mode; retrying same provider without response_format.`);
            const repairedMessages: ChatMessage[] = [
              ...messages,
              {
                role: 'user',
                content: `Previous JSON schema validation failed (${msg.slice(0, 120)}). Output valid JSON or structured blocks without strict server JSON mode.`,
              },
            ];
            return await provider.invoke(repairedMessages, false, maxTokens, role, emit);
          }
          throw err;
        }
      };

      try {
        const result = await invokeWithSchemaFallback();
        const latencyMs = Math.round((performance.now() - started) * 100) / 100;
        const routedVia = result.routedVia ?? null;
        const fallbackAttempts = result.fallbackAttempts ?? null;

        if (routedVia) {
          this.lastRoutedVia = routedVia;
        }

        this.healthMap.set(provider.name, {
          healthy: true,
          last_error: null,
          last_latency_ms: latencyMs,
        });
        this.activeProvider = provider.name;
        this.activeTier = provider.tier;

        if (provider.name === 'freellmapi' && routedVia) {
          const retrySuffix =
            fallbackAttempts !== null && String(fallbackAttempts).trim() !== ''
              ? ` (upstream retries: ${fallbackAttempts})`
              : '';
          emit?.('telemetry', `[HYDRA] FREELLMAPI responded in ${latencyMs}ms via ${routedVia}${retrySuffix}`);
        } else {
          emit?.('telemetry', `[HYDRA] ${provider.name.toUpperCase()} responded in ${latencyMs}ms (~${result.tokens} tokens).`);
        }

        return {
          content: result.text,
          provider: provider.name,
          model: result.modelUsed || displayModel,
          tier: provider.tier,
          latency_ms: latencyMs,
          tokens_estimated: result.tokens,
          routed_via: routedVia,
          fallback_attempts: fallbackAttempts,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${provider.name}: ${message}`);
        this.healthMap.set(provider.name, {
          healthy: false,
          last_error: message.slice(0, 180),
          last_latency_ms: null,
        });
        emit?.('telemetry', `[HYDRA FAILOVER] ${provider.name.toUpperCase()} fault (${message.slice(0, 100)}). Cascading to next provider...`);
      }
    }

    const lastUserMsg = messages[messages.length - 1]?.content.slice(0, 240) ?? '';
    const relayReply = await this.relay.transmitCompact(lastUserMsg);
    if (relayReply) {
      this.activeTier = 'TIER_2';
      return {
        content: JSON.stringify({
          thought: 'Tier 2 low-bandwidth relay response',
          plan: [],
          action: 'respond',
          code: '',
          target_file: null,
          response: relayReply,
        }),
        provider: 'low_bw_relay',
        model: 'relay-text',
        tier: 'TIER_2',
        latency_ms: 0,
        tokens_estimated: Math.ceil(relayReply.length / 4),
      };
    }

    this.activeTier = 'TIER_3';
    const summary = errors.length > 0 ? errors.join('; ') : 'No Tier 0/1 provider keys configured';
    throw new Error(`HYDRA_EXHAUSTED: ${summary}`);
  }
}
