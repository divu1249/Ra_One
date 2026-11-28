import fs from 'node:fs/promises';
import path from 'node:path';
import { MutationEngine } from './mutation';

export interface KnowledgeDocument {
  url: string;
  title: string;
  summary: string;
  code_snippets: string[];
  timestamp: number;
}

export interface DistilledRule {
  id: number;
  task_domain: string;
  error_signature: string;
  winning_strategy: string;
  source_urls: string[];
  timestamp: number;
}

export interface LearnedToolEntry {
  name: string;
  description: string;
  file_path: string;
  created_at: number;
}

const TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{1,48}$/;

export class KnowledgeStore {
  private readonly filePath: string;
  private documents: KnowledgeDocument[] = [];
  private rules: DistilledRule[] = [];
  private loaded = false;

  constructor(storagePath = path.resolve(process.cwd(), 'data', 'knowledge_store.json')) {
    this.filePath = storagePath;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as { documents?: KnowledgeDocument[]; rules?: DistilledRule[] };
      this.documents = Array.isArray(parsed.documents) ? parsed.documents : [];
      this.rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    } catch {
      this.documents = [];
      this.rules = [];
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify({ documents: this.documents, rules: this.rules }, null, 2),
      'utf-8'
    );
  }

  async upsertDocument(input: {
    url: string;
    title: string;
    summary: string;
    code_snippets?: string[];
  }): Promise<KnowledgeDocument> {
    await this.ensureLoaded();
    const doc: KnowledgeDocument = {
      url: input.url,
      title: input.title.slice(0, 200),
      summary: input.summary.slice(0, 2500),
      code_snippets: (input.code_snippets ?? []).slice(0, 6),
      timestamp: Date.now() / 1000,
    };
    const idx = this.documents.findIndex((d) => d.url === input.url);
    if (idx !== -1) {
      this.documents[idx] = doc;
    } else {
      this.documents.push(doc);
      if (this.documents.length > 200) this.documents.shift();
    }
    await this.persist();
    return doc;
  }

  async getByUrl(url: string): Promise<KnowledgeDocument | null> {
    await this.ensureLoaded();
    for (let i = this.documents.length - 1; i >= 0; i -= 1) {
      if (this.documents[i].url === url) return this.documents[i];
    }
    return null;
  }

  async search(query: string, topK = 3): Promise<KnowledgeDocument[]> {
    await this.ensureLoaded();
    if (this.documents.length === 0) return [];
    const tokens = new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
    const scored: Array<{ overlap: number; ts: number; doc: KnowledgeDocument }> = [];

    for (const doc of this.documents) {
      const hay = `${doc.title} ${doc.url} ${doc.summary}`.toLowerCase();
      const docTokens = new Set(hay.match(/[a-z0-9_]{2,}/g) ?? []);
      let overlap = 0;
      for (const t of tokens) {
        if (docTokens.has(t)) overlap += 1;
      }
      if (overlap > 0) {
        scored.push({ overlap, ts: doc.timestamp, doc });
      }
    }

    scored.sort((a, b) => b.overlap - a.overlap || b.ts - a.ts);
    return scored.slice(0, topK).map((s) => s.doc);
  }

  async recordRule(input: {
    task_domain: string;
    error_signature: string;
    winning_strategy: string;
    source_urls?: string[];
  }): Promise<DistilledRule> {
    await this.ensureLoaded();
    const nextId = this.rules.length > 0 ? this.rules[this.rules.length - 1].id + 1 : 1;
    const rule: DistilledRule = {
      id: nextId,
      task_domain: input.task_domain.slice(0, 120),
      error_signature: input.error_signature.slice(0, 180),
      winning_strategy: input.winning_strategy.slice(0, 800),
      source_urls: (input.source_urls ?? []).slice(0, 5),
      timestamp: Date.now() / 1000,
    };
    this.rules.push(rule);
    if (this.rules.length > 200) this.rules.shift();
    await this.persist();
    return rule;
  }

  async recallRules(query: string, topK = 3): Promise<DistilledRule[]> {
    await this.ensureLoaded();
    if (this.rules.length === 0) return [];
    const tokens = new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []);
    const scored: Array<{ overlap: number; id: number; rule: DistilledRule }> = [];

    for (const rule of this.rules) {
      const hay = `${rule.task_domain} ${rule.error_signature} ${rule.winning_strategy}`.toLowerCase();
      const rTokens = new Set(hay.match(/[a-z0-9_]{2,}/g) ?? []);
      let overlap = 0;
      for (const t of tokens) {
        if (rTokens.has(t)) overlap += 1;
      }
      if (overlap > 0) {
        scored.push({ overlap, id: rule.id, rule });
      }
    }

    scored.sort((a, b) => b.overlap - a.overlap || b.id - a.id);
    return scored.slice(0, topK).map((s) => s.rule);
  }

  async listAll(): Promise<{
    documents_count: number;
    rules_count: number;
    documents: KnowledgeDocument[];
    rules: DistilledRule[];
  }> {
    await this.ensureLoaded();
    return {
      documents_count: this.documents.length,
      rules_count: this.rules.length,
      documents: [...this.documents].reverse().slice(0, 50),
      rules: [...this.rules].reverse().slice(0, 50),
    };
  }
}

export class LearningEngine {
  readonly knowledge: KnowledgeStore;
  readonly toolsDir: string;
  readonly registryPath: string;
  readonly mutationEngine: MutationEngine;

  constructor(opts?: {
    knowledgePath?: string;
    toolsDir?: string;
    mutationEngine?: MutationEngine;
  }) {
    this.knowledge = new KnowledgeStore(opts?.knowledgePath);
    this.toolsDir = opts?.toolsDir ?? 'tools/learned';
    this.mutationEngine = opts?.mutationEngine ?? new MutationEngine();
    this.registryPath = path.resolve(this.mutationEngine.baseDir, this.toolsDir, 'registry.json');
  }

  private async loadRegistry(): Promise<LearnedToolEntry[]> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LearnedToolEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async saveRegistry(entries: LearnedToolEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
    await fs.writeFile(this.registryPath, JSON.stringify(entries, null, 2), 'utf-8');
  }

  async listLearnedTools(): Promise<LearnedToolEntry[]> {
    return this.loadRegistry();
  }

  async buildToolPromptBlock(): Promise<string> {
    const tools = await this.loadRegistry();
    if (tools.length === 0) return 'None registered yet.';
    return tools
      .slice(0, 15)
      .map((t) => `- ${t.name} (${t.file_path}): ${t.description}`)
      .join('\n');
  }

  async promoteTool(input: {
    toolName: string;
    description: string;
    code: string;
    criticApproved?: boolean;
  }): Promise<{ ok: boolean; tool?: LearnedToolEntry; mutation_id?: string; error?: string }> {
    const cleanName = input.toolName.trim();
    if (!TOOL_NAME_REGEX.test(cleanName)) {
      return {
        ok: false,
        error: 'Invalid tool_name. Use 2-49 alphanumeric/underscore characters starting with a letter or underscore.',
      };
    }

    const relPath = `${this.toolsDir.replace(/\/$/, '')}/${cleanName}.py`;
    const staged = await this.mutationEngine.stageAndVerify(relPath, input.code);
    if (!staged.passed) {
      return { ok: false, error: staged.report };
    }

    const applied = await this.mutationEngine.applyMutation(staged.mutation_id, input.criticApproved ?? true);
    if (!applied.ok) {
      return { ok: false, error: applied.error || 'Failed to register learned tool.' };
    }

    const entries = await this.loadRegistry();
    const entry: LearnedToolEntry = {
      name: cleanName,
      description: (input.description || `Learned Python utility ${cleanName}`).trim().slice(0, 300),
      file_path: relPath,
      created_at: Date.now() / 1000,
    };
    const filtered = entries.filter((e) => e.name !== cleanName);
    filtered.push(entry);
    await this.saveRegistry(filtered);

    await this.knowledge.recordRule({
      task_domain: 'tool_synthesis',
      error_signature: 'learned_tool',
      winning_strategy: `Promoted reusable tool '${cleanName}' at ${relPath}: ${entry.description}`,
    });

    return { ok: true, tool: entry, mutation_id: staged.mutation_id };
  }

  inferDomain(task: string): string {
    const lower = task.toLowerCase();
    if (/(http|scrape|web|url|search|api)/.test(lower)) return 'web_intelligence';
    if (/(mutat|diff|refactor|file|module)/.test(lower)) return 'self_mutation';
    if (/(regex|parse|json|csv|text)/.test(lower)) return 'data_parsing';
    return 'algorithm_engineering';
  }
}
