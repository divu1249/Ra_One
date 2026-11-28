import dns from 'node:dns/promises';
import net from 'node:net';
import type { TelemetryEmitter } from './hydra';
import type { KnowledgeStore } from './learning';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB hard cap
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_CONTEXT_CHARS = 6000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  '0.0.0.0',
  '::1',
  '::',
]);

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ScrapeResult {
  ok: boolean;
  url: string;
  title: string;
  text: string;
  links: string[];
  code_blocks: string[];
  tier_used: 'tier1_fetch' | 'tier2_jina' | 'tier3_cache' | 'blocked' | 'error';
  wrapped_content: string;
  error?: string;
}

export function isForbiddenIp(rawIp: string): boolean {
  const ip = rawIp.split('%')[0].toLowerCase();
  if (ip.startsWith('::ffff:')) {
    return isForbiddenIp(ip.slice(7));
  }
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // Link-local & cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast & reserved
    return false;
  }
  if (version === 6) {
    if (ip === '::' || ip === '::1') return true;
    if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('ff')) {
      return true;
    }
    return false;
  }
  return true;
}

export async function validatePublicUrl(
  rawUrl: string,
  resolveDns = true
): Promise<{ ok: boolean; reason?: string }> {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, reason: 'Empty URL rejected.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Malformed URL rejected.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol '${parsed.protocol}'. Only http/https allowed.` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (!host) return { ok: false, reason: 'Missing hostname in URL.' };

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return { ok: false, reason: `Blocked restricted hostname: ${host}` };
  }

  if (net.isIP(host)) {
    if (isForbiddenIp(host)) {
      return { ok: false, reason: `Blocked non-public IP: ${host}` };
    }
    return { ok: true };
  }

  if (resolveDns) {
    try {
      const records = await dns.lookup(host, { all: true });
      if (records.length === 0) {
        return { ok: false, reason: `DNS resolution yielded no records for ${host}` };
      }
      for (const rec of records) {
        if (isForbiddenIp(rec.address)) {
          return { ok: false, reason: `Blocked host resolving to non-public IP (${rec.address})` };
        }
      }
    } catch (err) {
      return {
        ok: false,
        reason: `DNS resolution failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: true };
}

export function wrapUntrustedWebData(sourceUrl: string, body: string): string {
  const safeSource = sourceUrl.replace(/["<>]/g, '').slice(0, 260);
  const safeBody = body.replace(/<\/untrusted_web_data>/gi, '[/untrusted_web_data]');
  return `<untrusted_web_data source="${safeSource}">\n${safeBody}\n</untrusted_web_data>`;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractHtmlContent(
  rawHtml: string,
  baseUrl: string
): { title: string; text: string; links: string[]; codeBlocks: string[] } {
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : '';

  const codeBlocks: string[] = [];
  for (const m of rawHtml.matchAll(/<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi)) {
    const snippet = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim();
    if (snippet.length >= 12 && !codeBlocks.includes(snippet)) {
      codeBlocks.push(snippet.slice(0, 1500));
    }
    if (codeBlocks.length >= 6) break;
  }

  const links: string[] = [];
  for (const m of rawHtml.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1].trim();
    if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')) {
      try {
        const resolved = new URL(href, baseUrl).toString();
        if (!links.includes(resolved)) links.push(resolved);
      } catch {
        // Ignore invalid relative href
      }
    }
    if (links.length >= 15) break;
  }

  const stripped = rawHtml
    .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  const lines = stripped
    .split('\n')
    .map((line) => decodeHtmlEntities(line).trim())
    .filter(Boolean);

  return { title, text: lines.join('\n'), links, codeBlocks };
}

function extractMarkdownCodeBlocks(md: string): string[] {
  const blocks: string[] = [];
  for (const m of md.matchAll(/```(?:[a-zA-Z0-9_+-]+)?\s*\n([\s\S]*?)```/g)) {
    const snippet = m[1].trim();
    if (snippet.length >= 12) blocks.push(snippet.slice(0, 1500));
    if (blocks.length >= 6) break;
  }
  return blocks;
}

function looksLikeJsWall(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    text.trim().length < 200 ||
    lower.includes('enable javascript') ||
    lower.includes('javascript is required') ||
    lower.includes('checking your browser') ||
    lower.includes('just a moment...') ||
    lower.includes('access denied')
  );
}

export class WebIntelligenceEngine {
  private readonly knowledgeStore?: KnowledgeStore;
  private uaIndex = 0;

  constructor(knowledgeStore?: KnowledgeStore) {
    this.knowledgeStore = knowledgeStore;
  }

  private nextHeaders(): Record<string, string> {
    const ua = USER_AGENTS[this.uaIndex % USER_AGENTS.length];
    this.uaIndex += 1;
    return {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  async fetchWithLimit(
    url: string,
    maxBytes = MAX_RESPONSE_BYTES,
    resolveDns = true
  ): Promise<{ status: number; contentType: string; body: string }> {
    let currentUrl = url;

    for (let hop = 0; hop < 5; hop += 1) {
      const check = await validatePublicUrl(currentUrl, resolveDns);
      if (!check.ok) {
        throw new Error(check.reason || 'Blocked unsafe URL');
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resp = await fetch(currentUrl, {
          method: 'GET',
          headers: this.nextHeaders(),
          redirect: 'manual',
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });

        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get('location')?.trim();
          if (!location) {
            throw new Error(`HTTP ${resp.status} redirect missing Location`);
          }
          currentUrl = new URL(location, currentUrl).toString();
          break;
        }

        if ((resp.status === 429 || resp.status === 503) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
          continue;
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        if (resp.body) {
          const reader = resp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const remaining = maxBytes - total;
            if (remaining <= 0) {
              await reader.cancel().catch(() => {});
              break;
            }
            if (value.byteLength > remaining) {
              chunks.push(value.subarray(0, remaining));
              total += remaining;
              await reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
            total += value.byteLength;
          }
        }

        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const body = new TextDecoder('utf-8', { fatal: false }).decode(merged);
        return {
          status: resp.status,
          contentType: resp.headers.get('content-type') || '',
          body,
        };
      }
    }

    throw new Error('Exceeded maximum redirect hops');
  }

  async webSearch(query: string, maxResults = 5, emit?: TelemetryEmitter): Promise<SearchResult[]> {
    const clean = query.trim();
    if (!clean) return [];
    emit?.('telemetry', `[WEB] Searching: ${clean.slice(0, 120)}`);

    const results: SearchResult[] = [];

    // Primary: DuckDuckGo HTML (no API key required)
    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`;
      const { status, body } = await this.fetchWithLimit(ddgUrl);
      if (status === 200 && body) {
        const pattern =
          /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
        for (const match of body.matchAll(pattern)) {
          let href = decodeHtmlEntities(match[1]);
          if (href.includes('uddg=')) {
            const rawTarget = href.split('uddg=')[1]?.split('&')[0] || '';
            try {
              href = decodeURIComponent(rawTarget);
            } catch {
              // keep href
            }
          }
          const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '')).trim();
          const snippet = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '')).trim();
          const okCheck = await validatePublicUrl(href, false);
          if (okCheck.ok && title) {
            results.push({ title, url: href, snippet });
          }
          if (results.length >= maxResults) break;
        }
      }
    } catch {
      // Fallback below
    }

    // Optional fallback: Tavily API if configured
    const tavilyKey = process.env.TAVILY_API_KEY?.trim();
    if (results.length === 0 && tavilyKey) {
      try {
        const resp = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: clean,
            max_results: maxResults,
            include_answer: false,
          }),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (resp.ok) {
          const data = (await resp.json()) as {
            results?: Array<{ url?: string; title?: string; content?: string }>;
          };
          for (const item of data.results ?? []) {
            const href = (item.url || '').trim();
            const okCheck = await validatePublicUrl(href, false);
            if (okCheck.ok) {
              results.push({
                title: item.title || href,
                url: href,
                snippet: item.content || '',
              });
            }
            if (results.length >= maxResults) break;
          }
        }
      } catch {
        // Ignore optional search failure
      }
    }

    emit?.('telemetry', `[WEB] Search yielded ${results.length} public result(s).`);
    return results.slice(0, maxResults);
  }

  async scrapeUrl(url: string, emit?: TelemetryEmitter): Promise<ScrapeResult> {
    const cleanUrl = url.trim();
    const check = await validatePublicUrl(cleanUrl, true);
    if (!check.ok) {
      emit?.('telemetry', `[WEB] Blocked unsafe URL (${check.reason})`);
      return {
        ok: false,
        url: cleanUrl,
        title: '',
        text: '',
        links: [],
        code_blocks: [],
        tier_used: 'blocked',
        wrapped_content: wrapUntrustedWebData(cleanUrl, `BLOCKED: ${check.reason}`),
        error: check.reason,
      };
    }

    const cached = this.knowledgeStore ? await this.knowledgeStore.getByUrl(cleanUrl) : null;
    emit?.('telemetry', `[WEB] Tier 1 scraping ${cleanUrl}`);

    let failureReason = '';
    try {
      const { status, contentType, body } = await this.fetchWithLimit(cleanUrl);
      if (status === 403 || status >= 400) {
        failureReason = `HTTP ${status}`;
      } else {
        const isHtml = contentType.toLowerCase().includes('html') || body.slice(0, 400).toLowerCase().includes('<html');
        const extracted = isHtml
          ? extractHtmlContent(body, cleanUrl)
          : { title: cleanUrl, text: body, links: [], codeBlocks: extractMarkdownCodeBlocks(body) };

        if (!looksLikeJsWall(extracted.text)) {
          const bounded = extracted.text.slice(0, MAX_CONTEXT_CHARS);
          if (this.knowledgeStore) {
            await this.knowledgeStore.upsertDocument({
              url: cleanUrl,
              title: extracted.title || cleanUrl,
              summary: bounded.slice(0, 1800),
              code_snippets: extracted.codeBlocks,
            });
          }
          return {
            ok: true,
            url: cleanUrl,
            title: extracted.title || cleanUrl,
            text: bounded,
            links: extracted.links,
            code_blocks: extracted.codeBlocks,
            tier_used: 'tier1_fetch',
            wrapped_content: wrapUntrustedWebData(cleanUrl, bounded),
          };
        }
        failureReason = 'minimal content (<200 chars) or JS wall';
      }
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
    }

    // Tier 2: JS/SPA fallback via r.jina.ai
    emit?.('telemetry', `[WEB] Tier 2 Jina fallback (${failureReason}) for ${cleanUrl}`);
    try {
      const jinaUrl = `https://r.jina.ai/${cleanUrl}`;
      const { status, body } = await this.fetchWithLimit(jinaUrl);
      if (status === 200 && body.trim().length >= 80) {
        const bounded = body.trim().slice(0, MAX_CONTEXT_CHARS);
        const firstLine = bounded.split('\n')[0]?.replace(/^#+\s*/, '').trim() || cleanUrl;
        const codeBlocks = extractMarkdownCodeBlocks(bounded);
        if (this.knowledgeStore) {
          await this.knowledgeStore.upsertDocument({
            url: cleanUrl,
            title: firstLine.slice(0, 160),
            summary: bounded.slice(0, 1800),
            code_snippets: codeBlocks,
          });
        }
        return {
          ok: true,
          url: cleanUrl,
          title: firstLine.slice(0, 160),
          text: bounded,
          links: [],
          code_blocks: codeBlocks,
          tier_used: 'tier2_jina',
          wrapped_content: wrapUntrustedWebData(cleanUrl, bounded),
        };
      }
    } catch (err2) {
      failureReason = `${failureReason}; tier2: ${err2 instanceof Error ? err2.message : String(err2)}`;
    }

    // Tier 3: Offline semantic knowledge cache
    if (cached) {
      emit?.('telemetry', `[WEB] Tier 3 serving cached knowledge for ${cleanUrl}`);
      const bounded = cached.summary.slice(0, MAX_CONTEXT_CHARS);
      return {
        ok: true,
        url: cleanUrl,
        title: cached.title,
        text: bounded,
        links: [],
        code_blocks: cached.code_snippets,
        tier_used: 'tier3_cache',
        wrapped_content: wrapUntrustedWebData(cleanUrl, bounded),
      };
    }

    return {
      ok: false,
      url: cleanUrl,
      title: '',
      text: '',
      links: [],
      code_blocks: [],
      tier_used: 'error',
      wrapped_content: wrapUntrustedWebData(cleanUrl, `SCRAPE FAILED: ${failureReason}`),
      error: failureReason,
    };
  }

  async researchTopic(
    query: string,
    maxUrls = 3,
    emit?: TelemetryEmitter
  ): Promise<{
    query: string;
    search_results: SearchResult[];
    documents: Array<{ title: string; url: string; tier: string; wrapped_content: string; code_blocks: string[] }>;
    context_block: string;
  }> {
    emit?.('telemetry', `[WEB] Researching topic: ${query.slice(0, 120)}`);
    const searchHits = await this.webSearch(query, maxUrls + 2, emit);
    const docs: Array<{ title: string; url: string; tier: string; wrapped_content: string; code_blocks: string[] }> = [];

    for (const hit of searchHits.slice(0, maxUrls)) {
      const scraped = await this.scrapeUrl(hit.url, emit);
      if (scraped.ok) {
        docs.push({
          title: scraped.title,
          url: scraped.url,
          tier: scraped.tier_used,
          wrapped_content: scraped.wrapped_content,
          code_blocks: scraped.code_blocks,
        });
      }
    }

    if (docs.length === 0 && this.knowledgeStore) {
      const cachedDocs = await this.knowledgeStore.search(query, maxUrls);
      if (cachedDocs.length > 0) {
        emit?.('telemetry', `[WEB] Tier 3 serving ${cachedDocs.length} cached doc(s) for '${query.slice(0, 60)}'`);
        for (const doc of cachedDocs) {
          docs.push({
            title: doc.title,
            url: doc.url,
            tier: 'tier3_cache',
            wrapped_content: wrapUntrustedWebData(doc.url, doc.summary),
            code_blocks: doc.code_snippets,
          });
        }
      }
    }

    const blocks = docs.map((d) => d.wrapped_content);
    if (blocks.length === 0 && searchHits.length > 0) {
      const snippetText = searchHits.map((h) => `- ${h.title} (${h.url}): ${h.snippet}`).join('\n');
      blocks.push(wrapUntrustedWebData('duckduckgo://search', snippetText));
    }

    return {
      query,
      search_results: searchHits,
      documents: docs,
      context_block: blocks.join('\n\n').slice(0, MAX_CONTEXT_CHARS * 2),
    };
  }
}
