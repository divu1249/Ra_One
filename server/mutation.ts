import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { computeUnifiedDiff, runPythonSandbox } from './sandbox';

const IMMUTABLE_KERNEL_FILES = new Set([
  'mutation_engine.py',
  'ra_one_core/mutation_engine.py',
  'sandbox.py',
  'ra_one_core/sandbox.py',
  'hydra_router.py',
  'ra_one_core/hydra_router.py',
  'agent_graph.py',
  'ra_one_core/agent_graph.py',
  'main.py',
  'ra_one_core/main.py',
  'server/mutation.ts',
  'server/sandbox.ts',
  'server/hydra.ts',
  'server/cognition.ts',
  'server.ts',
  '.env',
  '.env.local',
]);

const IMMUTABLE_BASENAMES = new Set([
  'mutation_engine.py',
  'sandbox.py',
  'mutation.ts',
  'sandbox.ts',
  '.env',
  '.env.local',
]);

export interface MutationLedgerRecord {
  mutation_id: string;
  target_file: string;
  diff: string;
  snapshot_path: string | null;
  proposed_code: string;
  status: 'staged' | 'applied' | 'rolled_back' | 'failed';
  created_at: number;
}

export interface StagedMutationResult {
  passed: boolean;
  blocked: boolean;
  mutation_id: string;
  header: string;
  diff: string;
  snapshot_path: string | null;
  report: string;
}

export class MutationEngine {
  readonly baseDir: string;
  readonly snapshotsDir: string;
  readonly ledgerPath: string;

  constructor(
    baseDir = process.cwd(),
    snapshotsDir = '.raone_snapshots',
    ledgerPath = '.raone_snapshots/mutations_ledger.json'
  ) {
    this.baseDir = path.resolve(baseDir);
    this.snapshotsDir = path.resolve(this.baseDir, snapshotsDir);
    this.ledgerPath = path.resolve(this.baseDir, ledgerPath);
  }

  static normalizeRel(targetFile: string): string {
    return targetFile.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  }

  isLiveMutationsEnabled(): boolean {
    return (process.env.ALLOW_LIVE_MUTATIONS || 'false').trim().toLowerCase() === 'true';
  }

  isLockedFile(targetFile: string): { locked: boolean; reason: string } {
    const rel = MutationEngine.normalizeRel(targetFile);
    if (!rel) {
      return { locked: true, reason: 'Empty target_file rejected.' };
    }
    const base = path.posix.basename(rel);
    if (
      IMMUTABLE_KERNEL_FILES.has(rel) ||
      IMMUTABLE_BASENAMES.has(base) ||
      rel.includes('.raone_snapshots')
    ) {
      return {
        locked: true,
        reason: `IMMUTABLE KERNEL LOCK: Modifications to '${rel}' are strictly prohibited.`,
      };
    }

    const absTarget = path.resolve(this.baseDir, rel);
    if (!absTarget.startsWith(this.baseDir + path.sep)) {
      return {
        locked: true,
        reason: `CONTAINMENT FAULT: Path '${rel}' escapes workspace root.`,
      };
    }

    return { locked: false, reason: '' };
  }

  async loadLedger(): Promise<MutationLedgerRecord[]> {
    try {
      const raw = await fs.readFile(this.ledgerPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as MutationLedgerRecord[]) : [];
    } catch {
      return [];
    }
  }

  private async saveLedger(records: MutationLedgerRecord[]): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    await fs.writeFile(this.ledgerPath, JSON.stringify(records.slice(-100), null, 2), 'utf-8');
  }

  async snapshotsCount(): Promise<number> {
    try {
      const files = await fs.readdir(this.snapshotsDir);
      return files.filter((f) => f.endsWith('.bak')).length;
    } catch {
      return 0;
    }
  }

  async createSnapshot(targetFile: string): Promise<string | null> {
    const rel = MutationEngine.normalizeRel(targetFile);
    const absTarget = path.resolve(this.baseDir, rel);
    if (!absTarget.startsWith(this.baseDir + path.sep)) return null;

    await fs.mkdir(this.snapshotsDir, { recursive: true });
    const sanitized = rel.replace(/[^a-zA-Z0-9._-]/g, '_');
    const snapPath = path.join(this.snapshotsDir, `${sanitized}.${Date.now()}.bak`);

    let original = '__RAONE_NEW_FILE_MARKER__';
    try {
      original = await fs.readFile(absTarget, 'utf-8');
    } catch {
      original = '__RAONE_NEW_FILE_MARKER__';
    }
    await fs.writeFile(snapPath, original, 'utf-8');
    return snapPath;
  }

  private async checkSyntax(rel: string, absTarget: string, newCode: string): Promise<{ ok: boolean; err: string }> {
    if (rel.endsWith('.py')) {
      const pyCheckScript = [
        'import ast, re, sys',
        'src = sys.stdin.read()',
        'ast.parse(src)',
        'for m in re.finditer(r"(?:f|fr|rf)[\\"\\\']{1,3}([\\s\\S]*?)[\\"\\\']{1,3}", src):',
        '    for expr in re.findall(r"\\{([^{}]+)\\}", m.group(1)):',
        '        if "\\\\" in expr:',
        '            raise SyntaxError("Python <3.12 backslash inside f-string expression")',
      ].join('\n');

      const astCheck = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        const child = execFile('python3', ['-c', pyCheckScript], { timeout: 5000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, err: stderr || err.message });
          else resolve({ ok: true, err: '' });
        });
        child.stdin?.end(newCode);
      });
      if (!astCheck.ok) return astCheck;

      const shadowPath = path.join(path.dirname(absTarget), `.shadow_${path.basename(absTarget)}`);
      try {
        await fs.mkdir(path.dirname(shadowPath), { recursive: true });
        await fs.writeFile(shadowPath, newCode, 'utf-8');
        const compileRes = await new Promise<{ ok: boolean; err: string }>((resolve) => {
          execFile('python3', ['-m', 'py_compile', shadowPath], { timeout: 5000 }, (err, _out, stderr) => {
            if (err) resolve({ ok: false, err: stderr || err.message });
            else resolve({ ok: true, err: '' });
          });
        });
        return compileRes;
      } finally {
        await fs.unlink(shadowPath).catch(() => {});
      }
    }

    if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
      const shadowPath = path.join(path.dirname(absTarget), `.shadow_${path.basename(absTarget)}`);
      try {
        await fs.mkdir(path.dirname(shadowPath), { recursive: true });
        await fs.writeFile(shadowPath, newCode, 'utf-8');
        return await new Promise<{ ok: boolean; err: string }>((resolve) => {
          execFile('node', ['--check', shadowPath], { timeout: 5000 }, (err, _out, stderr) => {
            if (err) resolve({ ok: false, err: stderr || err.message });
            else resolve({ ok: true, err: '' });
          });
        });
      } finally {
        await fs.unlink(shadowPath).catch(() => {});
      }
    }

    return { ok: true, err: '' };
  }

  async stageAndVerify(targetFile: string, newCode: string, testCode = ''): Promise<StagedMutationResult> {
    const rel = MutationEngine.normalizeRel(targetFile);
    const lock = this.isLockedFile(rel);
    if (lock.locked) {
      return {
        passed: false,
        blocked: true,
        mutation_id: '',
        header: '-- MUTATION BLOCKED --',
        diff: '',
        snapshot_path: null,
        report: lock.reason,
      };
    }

    const absTarget = path.resolve(this.baseDir, rel);
    let existing = '';
    try {
      existing = await fs.readFile(absTarget, 'utf-8');
    } catch {
      existing = '';
    }

    const diff = computeUnifiedDiff(rel, existing, newCode);
    const header = `-- MUTATION PIPELINE FOR ${rel} --`;

    // Step 1: Backup snapshot before touching workspace (removed if validation fails)
    const snapshotPath = await this.createSnapshot(rel);

    // Step 2 & 3: Shadow syntax check
    const syntax = await this.checkSyntax(rel, absTarget, newCode);
    if (!syntax.ok) {
      if (snapshotPath) await fs.unlink(snapshotPath).catch(() => {});
      return {
        passed: false,
        blocked: false,
        mutation_id: '',
        header,
        diff,
        snapshot_path: null,
        report: `SIMULATION FAILED:\n${syntax.err}`,
      };
    }

    // Step 4: Isolated sandbox verification for Python targets
    if (rel.endsWith('.py')) {
      const candidateScript = testCode.trim() ? `${newCode}\n\n${testCode}` : newCode;
      const sb = await runPythonSandbox(candidateScript, 10_000);
      if (!sb.success) {
        if (snapshotPath) await fs.unlink(snapshotPath).catch(() => {});
        return {
          passed: false,
          blocked: false,
          mutation_id: '',
          header,
          diff,
          snapshot_path: null,
          report: `SANDBOX VERIFICATION FAILED (exit ${sb.exitCode}):\n${sb.tracebackText}`,
        };
      }
    }

    const mutationId = `mut_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const ledger = await this.loadLedger();
    ledger.push({
      mutation_id: mutationId,
      target_file: rel,
      diff: diff || newCode,
      snapshot_path: snapshotPath,
      proposed_code: newCode,
      status: 'staged',
      created_at: Date.now() / 1000,
    });
    await this.saveLedger(ledger);

    return {
      passed: true,
      blocked: false,
      mutation_id: mutationId,
      header,
      diff: diff || newCode,
      snapshot_path: snapshotPath,
      report: `STAGED VERIFICATION PASSED (${mutationId}) for ${rel}.`,
    };
  }

  async applyMutation(
    mutationId: string,
    criticApproved = true
  ): Promise<{ ok: boolean; mutation_id?: string; target_file?: string; status?: string; rolled_back?: boolean; error?: string }> {
    if (!criticApproved) {
      return { ok: false, error: 'Critic approval required before applying mutation.' };
    }

    const ledger = await this.loadLedger();
    const rec = ledger.find((r) => r.mutation_id === mutationId);
    if (!rec) {
      return { ok: false, error: `Mutation '${mutationId}' not found.` };
    }

    const lock = this.isLockedFile(rec.target_file);
    if (lock.locked) {
      return { ok: false, error: lock.reason };
    }

    const absTarget = path.resolve(this.baseDir, rec.target_file);
    await fs.mkdir(path.dirname(absTarget), { recursive: true });
    const tmpPath = `${absTarget}.tmp_${process.pid}`;
    await fs.writeFile(tmpPath, rec.proposed_code, 'utf-8');
    await fs.rename(tmpPath, absTarget);

    // Post-swap integrity check -> auto-rollback on fault
    if (rec.target_file.endsWith('.py')) {
      const verify = await new Promise<{ ok: boolean; err: string }>((resolve) => {
        execFile('python3', ['-m', 'py_compile', absTarget], { timeout: 5000 }, (err, _out, stderr) => {
          if (err) resolve({ ok: false, err: stderr || err.message });
          else resolve({ ok: true, err: '' });
        });
      });
      if (!verify.ok) {
        await this.restoreFromSnapshot(absTarget, rec.snapshot_path);
        rec.status = 'rolled_back';
        await this.saveLedger(ledger);
        return {
          ok: false,
          rolled_back: true,
          error: `Post-swap fault triggered automatic rollback: ${verify.err}`,
        };
      }
    }

    rec.status = 'applied';
    await this.saveLedger(ledger);
    return {
      ok: true,
      mutation_id: mutationId,
      target_file: rec.target_file,
      status: 'applied',
    };
  }

  async restoreFromSnapshot(absTarget: string, snapPath: string | null): Promise<boolean> {
    if (!snapPath) return false;
    try {
      const content = await fs.readFile(snapPath, 'utf-8');
      if (content === '__RAONE_NEW_FILE_MARKER__') {
        await fs.unlink(absTarget).catch(() => {});
        return true;
      }
      await fs.mkdir(path.dirname(absTarget), { recursive: true });
      const tmpRestore = `${absTarget}.restore_tmp`;
      await fs.writeFile(tmpRestore, content, 'utf-8');
      await fs.rename(tmpRestore, absTarget);
      return true;
    } catch {
      return false;
    }
  }

  async rollbackMutation(mutationId: string): Promise<{ ok: boolean; mutation_id?: string; target_file?: string; status?: string; error?: string }> {
    const ledger = await this.loadLedger();
    const rec = ledger.find((r) => r.mutation_id === mutationId);
    if (!rec) {
      return { ok: false, error: `Mutation '${mutationId}' not found.` };
    }
    const absTarget = path.resolve(this.baseDir, rec.target_file);
    if (!absTarget.startsWith(this.baseDir + path.sep)) {
      return { ok: false, error: 'Snapshot target escapes containment.' };
    }
    const restored = await this.restoreFromSnapshot(absTarget, rec.snapshot_path);
    if (!restored) {
      return { ok: false, error: 'Snapshot missing or unreadable for rollback.' };
    }
    rec.status = 'rolled_back';
    await this.saveLedger(ledger);
    return { ok: true, mutation_id: rec.mutation_id, target_file: rec.target_file, status: 'rolled_back' };
  }

  async rollbackLatest(): Promise<{ ok: boolean; mutation_id?: string; target_file?: string; status?: string; error?: string }> {
    const ledger = await this.loadLedger();
    for (let i = ledger.length - 1; i >= 0; i -= 1) {
      const rec = ledger[i];
      if (rec.status === 'applied' && rec.snapshot_path) {
        const absTarget = path.resolve(this.baseDir, rec.target_file);
        if (!absTarget.startsWith(this.baseDir + path.sep)) {
          return { ok: false, error: 'Snapshot target escapes containment.' };
        }
        const restored = await this.restoreFromSnapshot(absTarget, rec.snapshot_path);
        if (restored) {
          rec.status = 'rolled_back';
          await this.saveLedger(ledger);
          return {
            ok: true,
            mutation_id: rec.mutation_id,
            target_file: rec.target_file,
            status: 'rolled_back',
          };
        }
      }
    }
    return { ok: false, error: 'No applied mutation snapshot available to roll back.' };
  }
}
