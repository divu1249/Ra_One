import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCognitionLoop } from './server/cognition.ts';
import { getGeminiApiKey, HydraRouter } from './server/hydra.ts';
import { LearningEngine } from './server/learning.ts';
import { EpisodicMemoryStore } from './server/memory.ts';
import { MutationEngine } from './server/mutation.ts';
import type { HealthDiagnostics, SSEEventType } from './server/schemas.ts';
import { WebIntelligenceEngine } from './server/web.ts';

dotenv.config();
dotenv.config({ path: '.env.local', override: false });

const resolvedGeminiKey = getGeminiApiKey();
if (resolvedGeminiKey && !process.env.GEMINI_API_KEY) {
  process.env.GEMINI_API_KEY = resolvedGeminiKey;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = '0.0.0.0';
const START_TIME = Date.now();

const router = new HydraRouter();
const memoryStore = new EpisodicMemoryStore();
const mutationEngine = new MutationEngine();
const learningEngine = new LearningEngine({ mutationEngine });
const webEngine = new WebIntelligenceEngine(learningEngine.knowledge);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', async (_req: Request, res: Response) => {
    const freeProbe = await router.probeFreeLlmApiHealth();
    const providers = router.getProviderStatuses();
    const activeTier = router.currentTier();
    const hasHealthy = providers.some((p) => p.healthy);
    const tools = await learningEngine.listLearnedTools();
    const knowledgeAll = await learningEngine.knowledge.listAll();

    const diagnostics: HealthDiagnostics = {
      status: activeTier === 'TIER_0' ? 'online' : hasHealthy ? 'degraded' : 'degraded',
      core: 'RA.ONE 2.0 // H.A.R.T.',
      active_tier: activeTier,
      active_provider: router.activeProvider,
      uptime_seconds: Math.round((Date.now() - START_TIME) / 10) / 100,
      providers,
      episodic_memory: await memoryStore.status(),
      sandbox: {
        ready: true,
        python_executable: 'python3',
        timeout_seconds: Number(process.env.SANDBOX_TIMEOUT_SECONDS || 10),
      },
      offline_queue_depth: await router.queue.pendingCount(),
      web_engine: 'ready',
      learned_tools: tools.map((t) => t.name),
      learned_tools_count: tools.length,
      knowledge_docs: knowledgeAll.documents_count,
      knowledge_docs_count: knowledgeAll.documents_count,
      snapshots_count: await mutationEngine.snapshotsCount(),
      freellmapi: freeProbe.status,
      freellmapi_models_available: freeProbe.models_available,
      last_routed_via: freeProbe.last_routed_via,
    };
    res.json(diagnostics);
  });

  app.get('/memory', async (_req: Request, res: Response) => {
    res.json({
      status: await memoryStore.status(),
      episodes: await memoryStore.listEpisodes(30),
    });
  });

  app.get('/knowledge', async (_req: Request, res: Response) => {
    res.json(await learningEngine.knowledge.listAll());
  });

  app.get('/tools/learned', async (_req: Request, res: Response) => {
    const tools = await learningEngine.listLearnedTools();
    res.json({
      count: tools.length,
      tools,
    });
  });

  app.get('/mutations', async (_req: Request, res: Response) => {
    res.json({
      allow_live_mutations: mutationEngine.isLiveMutationsEnabled(),
      snapshots_count: await mutationEngine.snapshotsCount(),
      mutations: await mutationEngine.loadLedger(),
    });
  });

  app.post('/mutations/rollback', async (_req: Request, res: Response) => {
    const result = await mutationEngine.rollbackLatest();
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/mutations/:id/apply', async (req: Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const result = await mutationEngine.applyMutation(id, true);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  });

  app.post('/mutations/:id/rollback', async (req: Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const result = await mutationEngine.rollbackMutation(id);
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
  });

  app.get('/queue', async (_req: Request, res: Response) => {
    res.json({
      pending_count: await router.queue.pendingCount(),
      items: await router.queue.listPending(),
    });
  });

  app.post('/queue/flush', async (_req: Request, res: Response) => {
    const pending = await router.queue.listPending();
    const results: Array<{ id: number; status: string }> = [];
    for (const item of pending) {
      const outcome = await runCognitionLoop({
        task: item.task,
        mode: 'live',
        router,
        memory: memoryStore,
        mutationEngine,
        learningEngine,
        webEngine,
        emit: () => {},
      });
      if (outcome.status !== 'queued') {
        await router.queue.markFlushed(item.id);
      }
      results.push({ id: item.id, status: outcome.status });
    }
    res.json({ flushed: results.filter((r) => r.status !== 'queued').length, results });
  });

  const handleChat = async (req: Request, res: Response) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const maxIterations = typeof req.body?.max_iterations === 'number' ? req.body.max_iterations : undefined;
    const targetFile = typeof req.body?.target_file === 'string' ? req.body.target_file : null;
    const mode = req.body?.mode === 'drill' ? 'drill' : 'live';

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const emit = (type: SSEEventType, content: string) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type, content })}\n\n`);
      }
    };

    try {
      if (!message) {
        emit('error', '[FAULT] Empty directive received.');
        res.end();
        return;
      }

      await runCognitionLoop({
        task: message,
        maxIterations,
        targetFile,
        mode,
        router,
        memory: memoryStore,
        mutationEngine,
        learningEngine,
        webEngine,
        emit,
      });
    } catch (err) {
      emit('error', `CRITICAL FAILURE: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  app.post('/chat', handleChat);
  app.post('/api/chat', handleChat);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: path.resolve(__dirname, 'ra_one_terminal'),
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'ra_one_terminal', 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`Server listening on http://localhost:${PORT} (bound to ${HOST}:${PORT})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start RA.ONE 2.0 server:', err);
  process.exit(1);
});
