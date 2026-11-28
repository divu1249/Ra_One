import fs from 'node:fs/promises';
import path from 'node:path';

export interface EpisodicLesson {
  id: number;
  task_type: string;
  task_summary: string;
  error_signature: string;
  winning_strategy: string;
  timestamp: number;
}

const RECALL_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'about',
  'write', 'python', 'function', 'script', 'verify', 'test', 'using', 'only',
]);

export class EpisodicMemoryStore {
  private readonly filePath: string;
  private episodes: EpisodicLesson[] = [];
  private loaded = false;

  constructor(storagePath = path.resolve(process.cwd(), 'data', 'episodic_memory.json')) {
    this.filePath = storagePath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.episodes = parsed;
      }
    } catch {
      this.episodes = [];
    }

    if (this.episodes.length === 0) {
      const supabaseUrl = process.env.SUPABASE_URL?.trim();
      const supabaseKey = process.env.SUPABASE_KEY?.trim();
      if (supabaseUrl && supabaseKey) {
        try {
          const resp = await fetch(
            `${supabaseUrl.replace(/\/$/, '')}/rest/v1/ra_one_episodic_memory?select=id,task_type,task_summary,error_signature,winning_strategy&order=id.desc&limit=50`,
            {
              headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
              },
              signal: AbortSignal.timeout(4000),
            }
          );
          if (resp.ok) {
            const rows = (await resp.json()) as Array<Partial<EpisodicLesson>>;
            if (Array.isArray(rows) && rows.length > 0) {
              this.episodes = rows
                .filter((r) => r.task_summary && r.winning_strategy)
                .reverse()
                .map((r, idx) => ({
                  id: typeof r.id === 'number' ? r.id : idx + 1,
                  task_type: r.task_type || 'run_python',
                  task_summary: r.task_summary || '',
                  error_signature: r.error_signature || 'verified_run',
                  winning_strategy: r.winning_strategy || '',
                  timestamp: Date.now() / 1000,
                }));
            }
          }
        } catch {
          // Best-effort remote hydration
        }
      }
    }

    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.episodes, null, 2), 'utf-8');
  }

  async status(): Promise<{ backend: string; supabase_configured: boolean; episode_count: number }> {
    await this.ensureLoaded();
    const supabaseConfigured = Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_KEY?.trim());
    return {
      backend: supabaseConfigured ? 'supabase+local-json' : 'local-json-vector',
      supabase_configured: supabaseConfigured,
      episode_count: this.episodes.length,
    };
  }

  async listEpisodes(limit = 25): Promise<EpisodicLesson[]> {
    await this.ensureLoaded();
    return [...this.episodes].reverse().slice(0, limit);
  }

  async recall(query: string, topK = 3): Promise<EpisodicLesson[]> {
    await this.ensureLoaded();
    if (this.episodes.length === 0) return [];

    const rawTokens = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [];
    const tokens = new Set(rawTokens.filter((t) => !RECALL_STOPWORDS.has(t)));

    // Query across BOTH past failure resolutions AND prior verified_run winning strategies
    const scored: Array<{ score: number; ep: EpisodicLesson }> = [];
    for (const ep of this.episodes) {
      const haystack = `${ep.task_type} ${ep.task_summary} ${ep.error_signature} ${ep.winning_strategy}`.toLowerCase();
      const epTokens = new Set((haystack.match(/[a-z0-9_]{2,}/g) ?? []).filter((t) => !RECALL_STOPWORDS.has(t)));
      let overlap = 0;
      for (const t of tokens) {
        if (epTokens.has(t)) overlap += 1;
      }
      if (overlap > 0) {
        scored.push({ score: overlap, ep });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.ep.id - a.ep.id);
    const results: EpisodicLesson[] = scored.slice(0, topK).map((s) => s.ep);

    // Backfill with recent verified_run / resolved_self_heal strategies so Episode #1+ patterns always inject
    if (results.length < topK) {
      const seenIds = new Set(results.map((r) => r.id));
      for (let i = this.episodes.length - 1; i >= 0 && results.length < topK; i -= 1) {
        const ep = this.episodes[i];
        if (!seenIds.has(ep.id)) {
          results.push(ep);
          seenIds.add(ep.id);
        }
      }
    }

    return results;
  }

  async recordEpisode(input: {
    task_type: string;
    task_summary: string;
    error_signature: string;
    winning_strategy: string;
  }): Promise<EpisodicLesson> {
    await this.ensureLoaded();
    const nextId = this.episodes.length > 0 ? this.episodes[this.episodes.length - 1].id + 1 : 1;
    const lesson: EpisodicLesson = {
      id: nextId,
      task_type: input.task_type,
      task_summary: input.task_summary.slice(0, 300),
      error_signature: input.error_signature.slice(0, 200),
      winning_strategy: input.winning_strategy.slice(0, 800),
      timestamp: Date.now() / 1000,
    };

    this.episodes.push(lesson);
    if (this.episodes.length > 200) {
      this.episodes.shift();
    }
    await this.persist();

    const supabaseUrl = process.env.SUPABASE_URL?.trim();
    const supabaseKey = process.env.SUPABASE_KEY?.trim();
    if (supabaseUrl && supabaseKey) {
      try {
        await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/ra_one_episodic_memory`, {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            task_type: lesson.task_type,
            task_summary: lesson.task_summary,
            error_signature: lesson.error_signature,
            winning_strategy: lesson.winning_strategy,
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Cloud sync best-effort; local persistence succeeded
      }
    }

    return lesson;
  }
}
